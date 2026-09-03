#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dual_proxy.py — 单端口双协议代理服务器（SOCKS5 + HTTP/HTTPS CONNECT）

用途：
    运行在有网络的 A 机上作为网络出口；B 机通过 UU远程的端口映射访问本端口，
    即可借助 A 机的网络上网。

特性：
    * 同一端口同时支持 SOCKS5（无认证，CONNECT）与 HTTP 代理（CONNECT / 绝对 URI 转发）
    * 域名在 A 机侧解析（B 机不需要有可用的 DNS）
    * 仅依赖 Python 3.7+ 标准库
    * 默认只监听 127.0.0.1，配合远程软件端口映射使用，不暴露到局域网
    * 内置本地 Web 状态面板（默认 http://127.0.0.1:10801/），可视化查看运行状态

用法：
    python dual_proxy.py                  # 监听 127.0.0.1:10800，面板 10801
    python dual_proxy.py --port 1080 -v   # 指定端口并打印详细日志
    python dual_proxy.py --no-panel       # 关闭 Web 状态面板
    python dual_proxy.py --host 0.0.0.0   # 监听所有网卡（注意：等于开放局域网代理）
"""

import argparse
import asyncio
import json
import logging
import os
import socket
import sys
import time
from urllib.parse import parse_qs, urlsplit

log = logging.getLogger("dualproxy")

BUF_SIZE = 65536
FIRST_BYTE_TIMEOUT = 30  # 秒

# 运行状态统计（单事件循环，无需加锁）
STATS = {"start_time": None, "total": 0, "active": 0, "recent": []}

# 接入终端登记表：终端名 -> {ip, first, last, beats}
# B 机的连接在 UU 端口映射后源 IP 都是 A 本机回环，无法靠 IP 区分终端，
# 因此由 B 端（浏览器扩展 / 脚本）定期上报 ?client=<终端名> 完成登记与心跳。
CLIENTS = {}
CLIENT_TTL = 120   # 秒：超过该时间未上报即视为离线（扩展默认每 60 秒心跳一次）
_LISTEN_HOST = "127.0.0.1"
_LISTEN_PORT = 10800


# ---------------------------------------------------------------- 终端登记

def _register_client(name, ip):
    """登记一个接入终端（幂等），name 为空时忽略。"""
    name = (name or "").strip()[:32]
    if not name:
        return
    now = time.time()
    c = CLIENTS.get(name)
    if c is None:
        CLIENTS[name] = {"ip": ip or "-", "first": now, "last": now, "beats": 1}
        log.info("终端接入: %s (%s)", name, ip or "-")
    else:
        if ip:
            c["ip"] = ip
        c["last"] = now
        c["beats"] = c.get("beats", 0) + 1


def _client_from_query(target):
    """从 /api/status?client=XXX 中取出终端名。"""
    if "?" not in target:
        return None
    q = parse_qs(target.split("?", 1)[1], keep_blank_values=False)
    v = q.get("client") or []
    return v[0] if v else None


def _clients_json():
    """在线/离线终端列表：名称、来源 IP、状态、接入时长、空闲时长、近 5 分钟连接数。"""
    now = time.time()
    out = []
    for name, c in CLIENTS.items():
        conns = sum(1 for e in STATS["recent"]
                    if e.get("ip") == c["ip"] and now - e.get("ts_e", 0) <= 300)
        out.append({
            "name": name,
            "ip": c["ip"],
            "online": (now - c["last"]) <= CLIENT_TTL,
            "since": int(now - c["first"]),
            "idle": int(now - c["last"]),
            "beats": c.get("beats", 0),
            "conns5m": conns,
        })
    out.sort(key=lambda x: (not x["online"], x["idle"]))
    return out


# ---------------------------------------------------------------- 基础工具

def _close(writer):
    try:
        writer.close()
    except Exception:
        pass


async def _pump(reader, writer, tag):
    """单向搬运数据，直到任一侧关闭或出错。"""
    try:
        while True:
            data = await reader.read(BUF_SIZE)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        log.debug("[%s] 传输中断: %r", tag, exc)
    finally:
        _close(writer)


async def _relay(c_reader, c_writer, r_reader, r_writer, tag):
    """在客户端与目标服务器之间双向搬运数据。"""
    t1 = asyncio.ensure_future(_pump(c_reader, r_writer, tag + " 上行"))
    t2 = asyncio.ensure_future(_pump(r_reader, c_writer, tag + " 下行"))
    try:
        await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (t1, t2):
            if not t.done():
                t.cancel()
    await asyncio.gather(t1, t2, return_exceptions=True)


def _log_conn(tag, proto, target, ip=None):
    """记录一条新的连接（用于状态面板）。"""
    STATS["total"] += 1
    STATS["active"] += 1
    STATS["recent"].append({
        "ts": time.strftime("%H:%M:%S"),
        "ts_e": time.time(),
        "proto": proto,
        "target": target,
        "client": tag,
        "ip": ip or (tag.rpartition(":")[0] if tag else "?"),
    })
    if len(STATS["recent"]) > 400:
        STATS["recent"].pop(0)


def _split_hostport(text, default_port):
    """把 host / host:port / [v6]:port 拆成 (host, port)。"""
    host, _, port = text.rpartition(":")
    if port.isdigit():
        return host.strip("[]"), int(port)
    return text.strip("[]"), default_port


# ---------------------------------------------------------------- SOCKS5

async def _handle_socks5(c_reader, c_writer, tag, bump):
    # 1. 握手：仅需无认证方式
    nmethods = (await c_reader.readexactly(1))[0]
    await c_reader.readexactly(nmethods)
    c_writer.write(b"\x05\x00")  # NO AUTHENTICATION
    await c_writer.drain()

    # 2. 请求
    ver, cmd, _rsv, atyp = await c_reader.readexactly(4)
    if ver != 5:
        raise ValueError("非 SOCKS5 协议版本: %d" % ver)

    if atyp == 0x01:  # IPv4
        host = socket.inet_ntoa(await c_reader.readexactly(4))
    elif atyp == 0x03:  # 域名（由 A 机解析）
        n = (await c_reader.readexactly(1))[0]
        host = (await c_reader.readexactly(n)).decode("utf-8", "replace")
    elif atyp == 0x04:  # IPv6
        host = socket.inet_ntop(socket.AF_INET6, await c_reader.readexactly(16))
    else:
        raise ValueError("未知 ATYP: %#x" % atyp)
    port = int.from_bytes(await c_reader.readexactly(2), "big")

    def reply(rep):
        # BND.ADDR=0.0.0.0 / BND.PORT=0，主流客户端均接受
        c_writer.write(bytes([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]))

    if cmd != 0x01:  # 仅支持 CONNECT（不支持 UDP ASSOCIATE / BIND）
        reply(0x07)
        await c_writer.drain()
        return

    try:
        r_reader, r_writer = await asyncio.open_connection(host, port)
    except Exception as exc:
        log.info("[%s] SOCKS5 连接失败 %s:%d (%r)", tag, host, port, exc)
        reply(0x01)
        await c_writer.drain()
        return

    reply(0x00)
    await c_writer.drain()
    log.info("[%s] SOCKS5 CONNECT %s:%d", tag, host, port)
    bump("SOCKS5", "%s:%d" % (host, port))
    await _relay(c_reader, c_writer, r_reader, r_writer, tag)


# ---------------------------------------------------------------- HTTP 代理

async def _handle_http(c_reader, c_writer, first_byte, tag, bump):
    request_line = first_byte + await c_reader.readline()
    parts = request_line.split()
    if len(parts) != 3:
        c_writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
        await c_writer.drain()
        return
    method = parts[0].decode("latin-1").upper()
    target = parts[1].decode("latin-1")

    header_lines = []
    while True:
        line = await c_reader.readline()
        if line in (b"\r\n", b"\n", b""):
            break
        header_lines.append(line)

    def bad(msg=b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"):
        c_writer.write(msg)

    # ---- 本地状态查询：直连的 GET /api/status 直接应答，不转发
    # 说明：经代理转发的请求是绝对 URI 形式（GET http://...），不会命中此分支；
    # 只有 B 机插件/curl 直连本端口（127.0.0.1:10800/api/status）的探测才会走到这里，
    # 用于 B 端识别当前借的是哪台 A（返回 host=本机主机名），仅一条端口映射即可工作。
    if method == "GET" and target.split("?", 1)[0] == "/api/status":
        # 若带 ?client=<终端名>，顺带完成该终端的登记/心跳
        _register_client(_client_from_query(target),
                         tag.rpartition(":")[0] if tag else None)
        body = json.dumps(_status_json(), ensure_ascii=False).encode("utf-8")
        head = (b"HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n"
                b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(body))
        c_writer.write(head + body)
        await c_writer.drain()
        return

    # ---- CONNECT（HTTPS 隧道）
    if method == "CONNECT":
        host, port = _split_hostport(target, 443)
        try:
            r_reader, r_writer = await asyncio.open_connection(host, port)
        except Exception as exc:
            log.info("[%s] CONNECT 失败 %s:%d (%r)", tag, host, port, exc)
            bad(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            return
        c_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await c_writer.drain()
        log.info("[%s] HTTP CONNECT %s:%d", tag, host, port)
        bump("HTTPS", "%s:%d" % (host, port))
        await _relay(c_reader, c_writer, r_reader, r_writer, tag)
        return

    # ---- 普通请求：绝对 URI（代理形式）或 origin-form + Host 头
    if "://" in target:
        u = urlsplit(target)
        if u.scheme.lower() not in ("http", "https"):
            bad()
            return
        host = u.hostname
        port = u.port or (443 if u.scheme.lower() == "https" else 80)
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        new_line = parts[0] + b" " + path.encode("latin-1") + b" " + parts[2]
        kept = []
        for h in header_lines:
            name = h.split(b":", 1)[0].strip().lower()
            if name in (b"proxy-connection", b"proxy-authorization"):
                continue  # 代理专用头不转发给目标服务器
            kept.append(h)
        payload = new_line + b"\r\n" + b"".join(kept) + b"\r\n"
    else:
        host_value = None
        for h in header_lines:
            if h.lower().startswith(b"host:"):
                host_value = h.split(b":", 1)[1].strip().decode("latin-1")
                break
        if not host_value:
            bad()
            return
        host, port = _split_hostport(host_value, 80)
        payload = request_line + b"".join(header_lines) + b"\r\n"

    try:
        r_reader, r_writer = await asyncio.open_connection(host, port)
    except Exception as exc:
        log.info("[%s] HTTP 转发失败 %s:%d (%r)", tag, host, port, exc)
        bad(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
        return

    log.info("[%s] HTTP %s %s:%d", tag, method, host, port)
    bump("HTTP %s" % method, "%s:%d" % (host, port))
    r_writer.write(payload)
    await r_writer.drain()
    await _relay(c_reader, c_writer, r_reader, r_writer, tag)


# ---------------------------------------------------------------- 入口

async def _handle_client(c_reader, c_writer):
    peer = c_writer.get_extra_info("peername")
    tag = "%s:%s" % (peer[0], peer[1]) if peer else "?"
    logged = 0

    def bump(proto, target):
        nonlocal logged
        logged += 1
        _log_conn(tag, proto, target)

    try:
        first = await asyncio.wait_for(c_reader.readexactly(1), FIRST_BYTE_TIMEOUT)
    except Exception:
        _close(c_writer)
        return

    try:
        if first == b"\x05":
            await _handle_socks5(c_reader, c_writer, tag, bump)
        else:
            await _handle_http(c_reader, c_writer, first, tag, bump)
    except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
        pass  # 对端中途断开属正常情况
    except Exception as exc:
        log.warning("[%s] 处理异常: %r", tag, exc)
    finally:
        STATS["active"] -= logged
        _close(c_writer)


# ---------------------------------------------------------------- 状态面板

def _status_json():
    up = int(time.time() - STATS["start_time"]) if STATS["start_time"] else 0
    clients = _clients_json()
    return {
        "running": True,
        "host": socket.gethostname(),
        "listen_host": _LISTEN_HOST,
        "listen_port": _LISTEN_PORT,
        "uptime": up,
        "total": STATS["total"],
        "active": STATS["active"],
        "recent": STATS["recent"][-50:],
        "clients": clients,
        "clients_online": sum(1 for c in clients if c["online"]),
        "client_ttl": CLIENT_TTL,
    }


def _dashboard_html():
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>A机代理运行状态</title>
<style>
  body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px}
  h1{font-size:20px;margin:0 0 16px}
  .cards{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px}
  .card{background:#1e293b;border-radius:12px;padding:16px 20px;min-width:140px;flex:1}
  .card .v{font-size:26px;font-weight:700;margin-top:6px}
  .card .k{font-size:13px;color:#94a3b8}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;margin-right:8px;box-shadow:0 0 8px #22c55e}
  table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:10px 14px;font-size:13px;border-bottom:1px solid #334155}
  th{background:#334155;color:#cbd5e1}
  .tag{background:#334155;border-radius:6px;padding:2px 8px;font-size:12px}
  h2{font-size:15px;margin:22px 0 10px;color:#cbd5e1}
  .on{color:#22c55e;font-weight:600}
  .offline{color:#94a3b8}
  .empty{color:#64748b}
</style>
</head>
<body>
  <h1><span class="dot"></span>A 机网络出口代理 — 运行状态</h1>
  <div class="cards">
    <div class="card"><div class="k">状态</div><div class="v" id="state">运行中</div></div>
    <div class="card"><div class="k">监听地址</div><div class="v" id="addr">-</div></div>
    <div class="card"><div class="k">已运行</div><div class="v" id="uptime">-</div></div>
    <div class="card"><div class="k">累计连接</div><div class="v" id="total">0</div></div>
    <div class="card"><div class="k">当前活跃</div><div class="v" id="active">0</div></div>
    <div class="card"><div class="k">接入终端（在线）</div><div class="v" id="clients">0</div></div>
  </div>
  <h2>接入终端</h2>
  <table>
    <thead><tr><th>终端名称</th><th>来源 IP</th><th>状态</th><th>接入时长</th>
               <th>最后上报</th><th>近 5 分钟连接</th></tr></thead>
    <tbody id="crows"><tr><td colspan="6">暂无终端上报</td></tr></tbody>
  </table>
  <h2>最近连接</h2>
    <thead><tr><th>时间</th><th>协议</th><th>客户端</th><th>目标</th></tr></thead>
    <tbody id="rows"><tr><td colspan="4">暂无连接</td></tr></tbody>
  </table>
  <button onclick="this.textContent='正在停止…';fetch('/api/stop',{method:'POST'});"
          style="margin:14px 0 4px;background:#cf222e;color:#fff;border:none;
                 padding:10px 18px;border-radius:8px;cursor:pointer;font-size:14px">
    停止代理
  </button>
  <p style="color:#64748b;font-size:12px;line-height:1.8">
    页面每 1 秒自动刷新。停止方式任选：<br>
    ① 点上方「停止代理」按钮；② 双击 <code>stop_proxy_A.bat</code>；
    ③ 命令行 <code>curl -X POST http://127.0.0.1:10801/api/stop</code>；
    ④ 任务管理器结束 <code>proxyA.exe</code> / <code>python.exe</code>。
  </p>
<script>
function esc(s){return String(s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function fmt(s){var h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h>0?h+"h ":"")+m+"m "+x+"s";}
async function tick(){
  try{
    var r=await fetch("/api/status");var d=await r.json();
    document.getElementById("addr").textContent=d.listen_host+":"+d.listen_port;
    document.getElementById("uptime").textContent=fmt(d.uptime);
    document.getElementById("total").textContent=d.total;
    document.getElementById("active").textContent=d.active;
    var cl=d.clients||[];
    document.getElementById("clients").textContent=(d.clients_online||0)+" / "+cl.length;
    var cb=document.getElementById("crows");
    if(!cl.length){cb.innerHTML='<tr><td colspan="6" class="empty">暂无终端上报（B 端扩展需为 v1.3+ 且已开启代理）</td></tr>';}
    else{
      cb.innerHTML=cl.map(function(c){
        return '<tr><td><b>'+esc(c.name)+'</b></td><td>'+esc(c.ip)+'</td><td class="'+
          (c.online?'on':'offline')+'">'+(c.online?'● 在线':'○ 离线')+'</td><td>'+fmt(c.since)+
          '</td><td>'+(c.idle<3?'刚刚':fmt(c.idle)+'前')+'</td><td>'+c.conns5m+'</td></tr>';
      }).join('');
    }
    var tb=document.getElementById("rows");
    if(!d.recent.length){tb.innerHTML='<tr><td colspan="4">暂无连接</td></tr>';return;}
    tb.innerHTML=d.recent.slice().reverse().map(function(e){
      return '<tr><td>'+e.ts+'</td><td><span class="tag">'+e.proto+'</span></td><td>'+e.client+'</td><td>'+e.target+'</td></tr>';
    }).join('');
  }catch(e){document.getElementById("state").textContent="无法连接";}
}
tick();setInterval(tick,1000);
</script>
</body>
</html>"""


async def _handle_status(reader, writer):
    try:
        peer = writer.get_extra_info("peername")
        peer_ip = peer[0] if peer else None
        line = await reader.readline()
        while True:
            h = await reader.readline()
            if h in (b"\r\n", b"\n", b""):
                break
        parts = line.split()
        path = parts[1].decode("latin-1") if len(parts) >= 2 else "/"

        if path == "/api/stop":
            # 由本机面板「停止代理」按钮触发；仅监听 127.0.0.1，外部不可达
            try:
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n"
                             b"Connection: close\r\n\r\n")
                await writer.drain()
            except Exception:
                pass
            asyncio.get_event_loop().call_later(0.3, os._exit, 0)
            return

        if path.split("?", 1)[0] == "/api/status":
            # 带 ?client=<终端名> 时完成该终端的登记/心跳
            _register_client(_client_from_query(path), peer_ip)
            body = json.dumps(_status_json(), ensure_ascii=False).encode("utf-8")
            head = (b"HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n"
                    b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(body))
            writer.write(head + body)
        elif path.split("?", 1)[0] == "/api/clients":
            _cl = _clients_json()
            body = json.dumps({"clients": _cl,
                               "clients_online": sum(1 for c in _cl if c["online"])},
                              ensure_ascii=False).encode("utf-8")
            head = (b"HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n"
                    b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(body))
            writer.write(head + body)
        elif path in ("/", "/index.html", "/dashboard"):
            html = _dashboard_html().encode("utf-8")
            head = (b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                    b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(html))
            writer.write(head + html)
        else:
            body = b"not found"
            head = (b"HTTP/1.1 404 Not Found\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
                    % len(body))
            writer.write(head + body)
        await writer.drain()
    except Exception:
        pass
    finally:
        _close(writer)


# ---------------------------------------------------------------- 主流程

async def main(args):
    global _LISTEN_HOST, _LISTEN_PORT
    server = await asyncio.start_server(_handle_client, args.host, args.port)
    _LISTEN_HOST, _LISTEN_PORT = args.host, args.port
    STATS["start_time"] = time.time()
    addrs = ", ".join("%s:%d" % s.getsockname()[:2] for s in server.sockets)

    status_srv = None
    if args.web_port:
        try:
            status_srv = await asyncio.start_server(_handle_status, "127.0.0.1", args.web_port)
        except Exception as exc:
            log.warning("状态面板启动失败（端口 %d 被占用？）：%r", args.web_port, exc)

    print("=" * 60)
    print(" 双协议代理已启动（SOCKS5 + HTTP）")
    print(" 监听地址   : %s" % addrs)
    print(" B 机配置   : 代理指向映射后的 127.0.0.1:%d" % args.port)
    if status_srv:
        print(" 状态面板   : 浏览器打开 http://127.0.0.1:%d/" % args.web_port)
    print(" 停止       : Ctrl+C")
    print("=" * 60)

    async with server:
        if status_srv:
            async with status_srv:
                await asyncio.gather(server.serve_forever(), status_srv.serve_forever())
        else:
            await server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="单端口双协议代理服务器（SOCKS5 + HTTP），配合远程软件端口映射使用")
    parser.add_argument("--host", default="127.0.0.1",
                        help="监听地址，默认 127.0.0.1（仅本机/端口映射可达）")
    parser.add_argument("--port", type=int, default=10800,
                        help="代理监听端口，默认 10800")
    parser.add_argument("--web-port", type=int, default=10801,
                        help="状态面板端口，默认 10801；设 0 关闭")
    parser.add_argument("--no-panel", action="store_true",
                        help="不启动 Web 状态面板")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="输出调试日志")
    args = parser.parse_args()
    if args.no_panel:
        args.web_port = 0

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        print("\n代理已停止。")
    sys.exit(0)
