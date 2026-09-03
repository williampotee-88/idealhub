// Background service worker (MV3): owns the proxy switch state + heartbeat.
//
// Order matters: the message listener is registered FIRST (right below),
// before anything that could throw (alarms, restore-on-startup, ...).
// If registration happened last, a failure above would leave the popup's
// click with no receiver at all -> "clicking the button does nothing".
//
// Every async branch catches its own errors and ALWAYS calls sendResponse,
// otherwise the popup callback never fires and the UI looks frozen.

const PROXY = { scheme: "socks5", host: "127.0.0.1", port: 10800, proxyDNS: true };

// A's status endpoints. The proxy port answers /api/status itself, so the
// single UU mapping (B:10800 -> A:10800) is enough; 10801 is a legacy fallback.
const STATUS_URLS = [
  "http://127.0.0.1:10800/api/status",
  "http://127.0.0.1:10801/api/status"
];

function errText(e) {
  try {
    const le = chrome.runtime.lastError;
    if (le) return String(le.message || le);
  } catch (_) { /* ignore */ }
  if (!e) return null;
  return String((e && e.message) || e);
}

function storageGet(keys) {
  return new Promise((res) => {
    try {
      chrome.storage.local.get(keys, (d) => res(d || {}));
    } catch (e) { res({}); }
  });
}

function storageSet(obj) {
  return new Promise((res) => {
    try {
      chrome.storage.local.set(obj, () => res());
    } catch (e) { res(); }
  });
}

// ---------------------------------------------------------------- proxy I/O
function setProxy(on) {
  return new Promise((resolve) => {
    try {
      const done = () => {
        const e = errText();
        resolve(e ? { ok: false, error: e } : { ok: true });
      };
      if (on) {
        chrome.proxy.settings.set({
          value: {
            mode: "fixed_servers",
            rules: {
              singleProxy: PROXY,
              // NOTE: do NOT add "<-loopback>" here. In Chrome it *removes*
              // the built-in loopback exemption, i.e. it forces 127.0.0.1
              // through the proxy -> the extension would forward its own
              // proxy connections to itself (self loop, everything times out).
              // Chrome already bypasses loopback by default; listing the
              // addresses explicitly just makes that intent obvious.
              bypassList: ["127.0.0.1", "localhost"]
            }
          },
          scope: "regular"
        }, done);
      } else {
        chrome.proxy.settings.clear({ scope: "regular" }, done);
      }
    } catch (e) {
      resolve({ ok: false, error: errText(e) || "unknown" });
    }
  });
}

function proxyState() {
  return new Promise((resolve) => {
    try {
      chrome.proxy.settings.get({ incognito: false }, (d) => {
        const e = errText();
        if (e) return resolve({ error: e });
        d = d || {};
        resolve({
          level: d.levelOfControl || null,
          mode: (d.value && d.value.mode) || null,
          rules: (d.value && d.value.rules) || null
        });
      });
    } catch (e) {
      resolve({ error: errText(e) || "unknown" });
    }
  });
}

// ----------------------------------------------------------------- heartbeat
// Report this browser's terminal name to A so A's dashboard can list which
// machines are borrowing its network. Runs even when the popup is closed.
async function heartbeat() {
  let d = {};
  try {
    d = await storageGet(["enabled", "clientName"]);
  } catch (e) { return null; }
  if (!d.enabled) return null;   // not borrowing A's network -> don't register
  const name = d.clientName || "未命名终端";
  for (const u of STATUS_URLS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(u + "?client=" + encodeURIComponent(name),
                            { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) return await r.json();
    } catch (e) { /* try the next endpoint */ }
  }
  return null;
}

async function probeStatus(name) {
  for (const u of STATUS_URLS) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(u + "?client=" + encodeURIComponent(name || "未命名终端"),
                            { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        return { url: u, ms: Date.now() - t0, host: j.host || null,
                 clients_online: (j.clients_online != null ? j.clients_online : null) };
      }
      return { url: u, ms: Date.now() - t0, http: r.status };
    } catch (e) {
      // keep going
    }
  }
  return { url: null, error: "两个状态端点均不可达（10800 / 10801）" };
}

// ------------------------------------------------------------ message router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const type = (msg && msg.type) || "";

      if (type === "get") {
        const d = await storageGet("enabled");
        const ps = await proxyState();
        return sendResponse({ enabled: !!d.enabled, level: ps.level || null,
                              mode: ps.mode || null, error: ps.error || null });
      }

      if (type === "toggle") {
        const d = await storageGet(["enabled", "clientName"]);
        const next = !d.enabled;
        const r = await setProxy(next);
        await storageSet({ enabled: next });
        const ps = await proxyState();
        const out = {
          enabled: next,
          ok: r.ok,
          error: r.error || null,
          level: ps.level || null,
          mode: ps.mode || null
        };
        if (next) {
          // register immediately instead of waiting for the next alarm tick
          heartbeat().catch(() => {});
        }
        return sendResponse(out);
      }

      if (type === "heartbeat") {
        const d = await storageGet(["enabled", "clientName"]);
        const st = d.enabled ? await probeStatus(d.clientName) : null;
        return sendResponse({ enabled: !!d.enabled, probe: st });
      }

      if (type === "diag") {
        const d = await storageGet(["enabled", "clientName"]);
        const ps = await proxyState();
        const st = await probeStatus(d.clientName || "未命名终端");
        return sendResponse({
          version: chrome.runtime.getManifest().version,
          enabled: !!d.enabled,
          clientName: d.clientName || null,
          level: ps.level || null,          // controllable_by_this_extension?
          mode: ps.mode || null,
          rules: ps.rules || null,
          probe: st,
          error: ps.error || null
        });
      }

      return sendResponse({ error: "unknown message type: " + type });
    } catch (e) {
      return sendResponse({ error: errText(e) || "background crashed" });
    }
  })();
  return true;   // keep the response channel open for the async reply
});

// ---------------------------------------------------- anything below may fail
// without affecting the message listener registered above.
try {
  chrome.alarms.create("heartbeat", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a && a.name === "heartbeat") heartbeat().catch(() => {});
  });
  chrome.runtime.onInstalled.addListener(() => {
    // Re-apply the current state so a previously stored bypass list (e.g. a
    // bad one from an older build) is replaced with the corrected rules.
    storageGet("enabled").then((d) => {
      if (d.enabled) setProxy(true).catch(() => {});
      return heartbeat();
    }).catch(() => {});
  });
  chrome.runtime.onStartup.addListener(() => { heartbeat().catch(() => {}); });
} catch (e) {
  // alarms unavailable -> heartbeats degrade to popup-open-only. Not fatal.
}

// Restore last state on startup.
storageGet("enabled").then((d) => {
  if (d.enabled) setProxy(true).catch(() => {});
});
