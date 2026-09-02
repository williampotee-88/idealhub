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

// Read the peer machine name from A's status API, so the user can tell
// which A machine this browser is currently borrowing network from.
// Primary: the proxy port itself (10800) — works with the single existing
// UU mapping and even with A running --no-panel (dual_proxy answers
// GET /api/status directly on the proxy port).
// Fallback: legacy panel port 10801 (requires B:10801 -> A:10801 mapped).
async function fetchPeerName() {
  const urls = [
    "http://127.0.0.1:10800/api/status",
    "http://127.0.0.1:10801/api/status"
  ];
  for (const u of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(u, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const d = await r.json();
        if (d && d.host) return d.host;
      }
    } catch (e) { /* try next endpoint */ }
  }
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
        : "● 已连接 A，出口 IP：" + ip + "（A 端为旧版，更新后显示对端名）";
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
