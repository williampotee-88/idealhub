const btn = document.getElementById("toggle");
const status = document.getElementById("status");   // 开关状态
const conn = document.getElementById("conn");        // 连接状态
const refreshBtn = document.getElementById("refresh");
const errBox = document.getElementById("err");       // 错误提示
const diagBtn = document.getElementById("diag");
const diagOut = document.getElementById("diagout");

function showErr(msg) {
  if (!errBox) return;
  errBox.textContent = msg || "";
  errBox.style.display = msg ? "block" : "none";
}

// Endpoints that return the client's public IP (used to prove the link works).
const DETECT = [
  "https://api.ipify.org?format=json",
  "https://ipwho.is/"
];

function parseIp(text) {
  try {
    const j = JSON.parse(text);
    if (j && j.ip) return j.ip;
  } catch (e) { /* not JSON */ }
  const m = text && text.match(/(\d{1,3}\.){3}\d{1,3}/);
  return m ? m[0] : null;
}

async function fetchIp() {
  for (const u of DETECT) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(u, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const ip = parseIp(await r.text());
        if (ip) return ip;
      }
    } catch (e) { /* try next endpoint */ }
  }
  return null;
}

// Read A's status. The ?client=<name> parameter doubles as this terminal's
// heartbeat, so A's dashboard can list which machines are borrowing its
// network. Primary: the proxy port itself (10800) — works with the single
// existing UU mapping and even with A running --no-panel.
// Fallback: legacy panel port 10801 (requires B:10801 -> A:10801 mapped).
// 上次成功拿到的对端名：偶发超时时不至于让显示来回闪
let lastPeer = null;

async function fetchStatus(clientName) {
  const q = "?client=" + encodeURIComponent(clientName || "未命名终端");
  for (const base of ["http://127.0.0.1:10800/api/status",
                      "http://127.0.0.1:10801/api/status"]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(base + q, { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(t);
        if (r.ok) {
          const j = await r.json();
          return {
            ok: true,
            host: j.host || null,                       // A 的机器名（旧版 A 没有）
            clients_online: (j.clients_online != null ? j.clients_online : null)
          };
        }
      } catch (e) { /* retry once, then next endpoint */ }
    }
  }
  return { ok: false };
}

function getEnabled() {
  return new Promise((res) =>
    chrome.storage.local.get("enabled", (d) => res(!!d.enabled))
  );
}

// ---- 终端名称：A 机面板靠它识别"谁在借网"，存本地，可自行修改
const nameInput = document.getElementById("cname");
const savedTip = document.getElementById("saved");

function getClientName() {
  return new Promise((res) =>
    chrome.storage.local.get("clientName", (d) => res(d.clientName || ""))
  );
}

async function ensureClientName() {
  let n = await getClientName();
  if (!n) {
    n = "B-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    await chrome.storage.local.set({ clientName: n });
  }
  if (nameInput) nameInput.value = n;
  return n;
}

function saveClientName() {
  if (!nameInput) return;
  const n = (nameInput.value || "").trim().slice(0, 32) || "未命名终端";
  chrome.storage.local.set({ clientName: n }, () => {
    if (savedTip) {
      savedTip.textContent = "已保存：" + n;
      setTimeout(() => { savedTip.textContent = ""; }, 2000);
    }
    refreshConn();
  });
}

if (nameInput) {
  nameInput.addEventListener("change", saveClientName);
  nameInput.addEventListener("blur", saveClientName);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); }
  });
}

async function refreshConn() {
  const en = await getEnabled();
  status.textContent = en ? "开关：走 A 网络" : "开关：本机网络";
  status.className = "state " + (en ? "on" : "off");
  btn.textContent = en ? "关闭（恢复本机）" : "开启（走 A）";
  btn.className = en ? "btn-off" : "btn-on";

  conn.textContent = "连接检测中…";
  conn.className = "conn";

  const name = await ensureClientName();
  const [ip, st] = await Promise.all([
    fetchIp(),
    en ? fetchStatus(name) : Promise.resolve(null)
  ]);
  if (st && st.ok && st.host) lastPeer = st.host;
  const peer = lastPeer;

  if (en) {
    if (ip) {
      let s = peer
        ? "● 已连接 A（对端：" + peer + "），出口 IP：" + ip
        : "● 已连接 A，出口 IP：" + ip;
      if (st && st.ok && st.clients_online != null) s += "，在线终端 " + st.clients_online + " 台";
      // 区分两种"没有对端名"：A 确实没返回该字段 vs 压根没探到 A
      if (st && st.ok && !st.host) s += "（A 端版本较旧，未返回机器名）";
      else if (!st || !st.ok) s += "（未取到 A 状态，点「一键诊断」看原因）";
      conn.textContent = s;
    } else {
      conn.textContent = "✕ 代理已开，但连不上 A（检查 A 机/映射）";
    }
  } else {
    conn.textContent = ip
      ? "● 本机直连，IP：" + ip
      : "✕ 本机网络异常";
  }
  conn.className = "conn " + (ip ? "ok" : "bad");
}

// ---- 开关：切状态 + 立刻给反馈，任何异常都显示出来（不再"点击无反应"）
let switching = false;

function levelHint(level) {
  if (!level || level === "controllable_by_this_extension") return null;
  if (level === "controlled_by_other_extensions")
    return "代理被其他扩展占用，本扩展无法切换（禁用其他代理扩展后重试）";
  if (level === "controllable_by_other_extensions")
    return "其他扩展优先级更高，本扩展的设置不会生效";
  if (level === "controlled_by_policy")
    return "代理被组策略/企业策略锁定（chrome://policy 查看），扩展无法修改";
  return "代理控制权：" + level;
}

btn.addEventListener("click", () => {
  if (switching) return;
  switching = true;
  btn.disabled = true;
  btn.textContent = "切换中…";
  showErr("");

  let settled = false;
  const finish = (res) => {
    if (settled) return;
    settled = true;
    switching = false;
    btn.disabled = false;
    res = res || {};
    const le = (() => { try { return chrome.runtime.lastError; } catch (e) { return null; } })();
    const msg = res.error || (le && le.message) || levelHint(res.level);
    if (msg) showErr("切换失败：" + msg);
    refreshConn();
  };

  try {
    chrome.runtime.sendMessage({ type: "toggle" }, finish);
  } catch (e) {
    finish({ error: String((e && e.message) || e) });
  }
  // 后台万一没响应（service worker 崩溃/未重新加载），也要给出可操作的提示
  setTimeout(() => finish({
    error: "后台无响应。请到 chrome://extensions 找到本扩展 → 点“重新加载”，或点 “Service worker / 查看视图” 看报错"
  }), 8000);
});

if (refreshBtn) refreshBtn.addEventListener("click", refreshConn);

// ---- 一键诊断：把"为什么切不动/连不上"直接列出来
if (diagBtn) {
  diagBtn.addEventListener("click", () => {
    diagOut.textContent = "诊断中…";
    diagOut.style.display = "block";
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      const le = (() => { try { return chrome.runtime.lastError; } catch (e) { return null; } })();
      if (le || !res) {
        diagOut.textContent = "扩展后台无响应（" + ((le && le.message) || "无返回") +
          "）。请到 chrome://extensions 重新加载本扩展后重试。";
        return;
      }
      if (res.error) { diagOut.textContent = "读取代理设置失败：" + res.error; return; }
      const p = res.probe || {};
      const lines = [
        "扩展版本: " + res.version,
        "开关状态: " + (res.enabled ? "开启（走 A）" : "关闭（本机）"),
        "终端名称: " + (res.clientName || "(未设置)"),
        "代理控制权: " + res.level +
          (res.level === "controllable_by_this_extension" ? "  ✅ 可控制" : "  ⚠️ 不可控制"),
        "当前代理模式: " + (res.mode || "(无)"),
        "A 状态探测: " + (p.url
          ? "✅ " + p.url + " (" + (p.ms != null ? p.ms + "ms" : "-") + ")" +
            (p.host ? "，对端=" + p.host : "") +
            (p.clients_online != null ? "，在线终端 " + p.clients_online + " 台" : "")
          : "✕ " + (p.error || "不可达"))
      ];
      const hint = levelHint(res.level);
      if (hint) lines.push("⚠️ " + hint);
      if (!p.url && res.enabled) lines.push("提示: A 机未运行代理，或 UU 端口映射未开/端口不是 10800");
      diagOut.textContent = lines.join("\n");
    };
    try {
      chrome.runtime.sendMessage({ type: "diag" }, finish);
    } catch (e) { finish(null); }
    setTimeout(() => finish(null), 10000);
  });
}

refreshConn();
// Keep the status live while the popup is open.
const timer = setInterval(refreshConn, 8000);
window.addEventListener("unload", () => clearInterval(timer));
