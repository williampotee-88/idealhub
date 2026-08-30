const btn = document.getElementById("toggle");
const status = document.getElementById("status");   // 开关状态
const conn = document.getElementById("conn");        // 连接状态
const refreshBtn = document.getElementById("refresh");

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

// Read the peer machine name from A's local status panel (port 10801).
// This address is bypassed by the proxy, so it reaches A via the UU mapping
// directly (requires B:10801 -> A:10801 mapped in UU).
async function fetchPeerName() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch("http://127.0.0.1:10801/api/status", { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const d = await r.json();
      return d.host || null;
    }
  } catch (e) { /* panel not mapped / not reachable */ }
  return null;
}

function getEnabled() {
  return new Promise((res) =>
    chrome.storage.local.get("enabled", (d) => res(!!d.enabled))
  );
}

async function refreshConn() {
  const en = await getEnabled();
  status.textContent = en ? "开关：走 A 网络" : "开关：本机网络";
  status.className = "state " + (en ? "on" : "off");
  btn.textContent = en ? "关闭（恢复本机）" : "开启（走 A）";
  btn.className = en ? "btn-off" : "btn-on";

  conn.textContent = "连接检测中…";
  conn.className = "conn";

  const [ip, peer] = await Promise.all([fetchIp(), en ? fetchPeerName() : Promise.resolve(null)]);

  if (en) {
    if (ip) {
      conn.textContent = peer
        ? "● 已连接 A（对端：" + peer + "），出口 IP：" + ip
        : "● 已连接 A，出口 IP：" + ip + "（未映射 10801 面板）";
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

btn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "toggle" }, () => refreshConn());
});
if (refreshBtn) refreshBtn.addEventListener("click", refreshConn);

refreshConn();
// Keep the status live while the popup is open.
const timer = setInterval(refreshConn, 8000);
window.addEventListener("unload", () => clearInterval(timer));
