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

// Read A's status. The ?client=<name> parameter doubles as this terminal's
// heartbeat, so A's dashboard can list which machines are borrowing its
// network. Primary: the proxy port itself (10800) — works with the single
// existing UU mapping and even with A running --no-panel.
// Fallback: legacy panel port 10801 (requires B:10801 -> A:10801 mapped).
async function fetchStatus(clientName) {
  for (const base of ["http://127.0.0.1:10800/api/status",
                      "http://127.0.0.1:10801/api/status"]) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const url = base + "?client=" + encodeURIComponent(clientName || "未命名终端");
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) return await r.json();
    } catch (e) { /* try next endpoint */ }
  }
  return null;
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
  const peer = st && st.host ? st.host : null;

  if (en) {
    if (ip) {
      conn.textContent = peer
        ? "● 已连接 A（对端：" + peer + "），出口 IP：" + ip +
          (st && st.clients_online != null ? "，在线终端 " + st.clients_online + " 台" : "")
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
