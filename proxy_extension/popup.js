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

// All network probes run in the background service worker: it must survive the
// popup closing, and it can record per-endpoint failures for the diagnostic.
function ask(msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      const le = (() => { try { return chrome.runtime.lastError; } catch (e) { return null; } })();
      resolve(res || { __error: (le && le.message) || "后台无响应" });
    };
    try {
      chrome.runtime.sendMessage(msg, finish);
    } catch (e) {
      finish({ __error: String((e && e.message) || e) });
    }
    setTimeout(() => finish(null), timeoutMs || 12000);
  });
}

function getEnabled() {
  return new Promise((res) =>
    chrome.storage.local.get("enabled", (d) => res(!!d.enabled))
  );
}

// ---------------------------------------------------------------- 终端名称
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
  if (nameInput && document.activeElement !== nameInput) nameInput.value = n;
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

// ---------------------------------------------------------------- 状态渲染
let lastPeer = null;   // 上次成功拿到的对端名，避免偶发超时导致显示来回跳

async function refreshConn() {
  const en = await getEnabled();
  status.textContent = en ? "开关：走 A 网络" : "开关：本机网络";
  status.className = "state " + (en ? "on" : "off");
  btn.textContent = en ? "关闭（恢复本机）" : "开启（走 A）";
  btn.className = en ? "btn-off" : "btn-on";

  conn.textContent = "连接检测中…";
  conn.className = "conn";

  await ensureClientName();
  const r = await ask({ type: "status" }, 14000);

  if (r && r.__error) {
    conn.textContent = "✕ 无法读取状态：" + r.__error;
    conn.className = "conn bad";
    showErr("后台未响应。请到 chrome://extensions 找到本扩展 → 点“重新加载”。");
    return;
  }

  const ip = r.ip;
  const probe = r.probe;
  if (probe && probe.ok && probe.host) lastPeer = probe.host;
  else if (r.lastPeer) lastPeer = r.lastPeer;

  if (en) {
    if (ip) {
      let s = lastPeer
        ? "● 已连接 A（对端：" + lastPeer + "），出口 IP：" + ip
        : "● 已连接 A，出口 IP：" + ip;
      if (probe && probe.ok && probe.clients_online != null)
        s += "，在线终端 " + probe.clients_online + " 台";
      // 区分"探到了但没有机器名字段"与"压根没探到"
      if (probe && probe.ok && !probe.host) s += "（A 端版本较旧，未返回机器名）";
      else if (!probe || !probe.ok) s += "（未取到 A 状态，点「一键诊断」看原因）";
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

// ---------------------------------------------------------------- 开关
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
  setTimeout(() => finish({
    error: "后台无响应。请到 chrome://extensions 找到本扩展 → 点“重新加载”，或点 “Service worker / 查看视图” 看报错"
  }), 8000);
});

if (refreshBtn) refreshBtn.addEventListener("click", refreshConn);

// ---------------------------------------------------------------- 一键诊断
function attemptLine(a) {
  if (!a) return "";
  const ms = (a.ms != null ? a.ms + "ms" : "-");
  if (a.ok) return "  ✅ " + a.via + " " + a.url + " (" + ms + ")";
  let why = "";
  if (a.http != null) why = "HTTP " + a.http;
  else if (a.err) why = a.err.replace(/^TypeError:\s*/, "");
  return "  ✕ " + a.via + " " + a.url + " (" + ms + ")" + (why ? " — " + why : "");
}

if (diagBtn) {
  diagBtn.addEventListener("click", async () => {
    diagOut.textContent = "诊断中…";
    diagOut.style.display = "block";
    const res = await ask({ type: "diag" }, 25000);
    if (!res || res.__error) {
      diagOut.textContent = "扩展后台无响应（" + ((res && res.__error) || "无返回") +
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
      "A 状态探测: " + (p.ok
        ? "✅ 成功（" + p.via + "，" + (p.ms != null ? p.ms + "ms" : "-") + "）" +
          (p.host ? "，对端=" + p.host : "，A 未返回机器名") +
          (p.clients_online != null ? "，在线终端 " + p.clients_online + " 台" : "")
        : "✕ 全部路径均失败")
    ];
    if (p.attempts && p.attempts.length) {
      lines.push("各路径明细:");
      p.attempts.forEach((a) => lines.push(attemptLine(a)));
    }
    const hint = levelHint(res.level);
    if (hint) lines.push("⚠️ " + hint);
    if (!p.ok && res.enabled) {
      lines.push("提示: 若“经代理通道”也失败，说明代理本身不通（A 未运行或 UU 映射未开）；" +
                 "若只有“直连映射”失败而其他成功，属正常，不影响使用。");
    }
    diagOut.textContent = lines.join("\n");
  });
}

refreshConn();
// Keep the status live while the popup is open.
const timer = setInterval(refreshConn, 8000);
window.addEventListener("unload", () => clearInterval(timer));
