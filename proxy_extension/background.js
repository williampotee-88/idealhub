// Background service worker (MV3): owns the proxy switch state, heartbeat,
// and ALL network probes (the popup only renders what this returns).
//
// Order matters: the message listener is registered FIRST (right below),
// before anything that could throw (alarms, restore-on-startup, ...).
// If registration happened last, a failure above would leave the popup's
// click with no receiver at all -> "clicking the button does nothing".
//
// Every async branch catches its own errors and ALWAYS calls sendResponse,
// otherwise the popup callback never fires and the UI looks frozen.

const PROXY = { scheme: "socks5", host: "127.0.0.1", port: 10800, proxyDNS: true };

// A's status endpoints, tried in order.
//
// Why there are several: browsing traffic goes through the SOCKS5 proxy
// channel, but "direct to 127.0.0.1" is a DIFFERENT path (loopback is
// bypassed). Some setups forward only the proxy channel, or the browser
// restricts extension access to local addresses — the symptom is that
// browsing works (public IP is shown) while the direct probe times out.
//
// So after the direct attempt we probe THROUGH the proxy itself using a
// reserved IP (240.0.0.1, IANA reserved -> never routed). A answers that
// request locally instead of dialling out. If browsing works at all, this
// path works too; it needs no extra port mapping.
const STATUS_ENDPOINTS = [
  { url: "http://127.0.0.1:10800/api/status", via: "直连映射" },
  { url: "http://240.0.0.1/api/status",        via: "经代理通道" },
  { url: "http://a-status.proxy/api/status",   via: "经代理(域名)" },
  { url: "http://127.0.0.1:10801/api/status",  via: "面板端口" }
];

const PROBE_TIMEOUT = 5000;

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

// ------------------------------------------------------------------ probing
// Endpoints that echo the caller's public IP (proves the borrowed link works).
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

// Probe A's status. Records every attempt so the diagnostic can show exactly
// which path works and which does not (no more guessing).
async function probeStatus(name) {
  const q = "?client=" + encodeURIComponent(name || "未命名终端");
  const attempts = [];
  for (const ep of STATUS_ENDPOINTS) {
    const t0 = Date.now();
    let rec = { url: ep.url, via: ep.via, ok: false };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
      const r = await fetch(ep.url + q, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      rec.ms = Date.now() - t0;
      if (r.ok) {
        const j = await r.json();
        rec.ok = true;
        attempts.push(rec);
        return {
          ok: true, url: ep.url, via: ep.via, ms: rec.ms,
          host: j.host || null,
          clients_online: (j.clients_online != null ? j.clients_online : null),
          attempts: attempts
        };
      }
      rec.http = r.status;
    } catch (e) {
      rec.ms = Date.now() - t0;
      rec.err = String((e && e.message) || e);
    }
    attempts.push(rec);
  }
  return { ok: false, attempts: attempts };
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
  const st = await probeStatus(d.clientName || "未命名终端");
  if (st && st.ok) {
    const keep = { lastPeer: st.host || null, lastVia: st.via || null,
                   lastProbeAt: Date.now() };
    storageSet(keep).catch(() => {});
    return st;
  }
  storageSet({ lastProbeAt: Date.now() }).catch(() => {});
  return null;
}

// ------------------------------------------------------------ message router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const type = (msg && msg.type) || "";

      // One-shot snapshot for the popup: switch state + public IP + A status.
      if (type === "status") {
        const d = await storageGet(["enabled", "clientName", "lastPeer"]);
        const ps = await proxyState();
        const en = !!d.enabled;
        const [ip, st] = await Promise.all([
          fetchIp(),
          en ? probeStatus(d.clientName) : Promise.resolve(null)
        ]);
        if (st && st.ok && st.host) storageSet({ lastPeer: st.host }).catch(() => {});
        return sendResponse({
          enabled: en,
          level: ps.level || null,
          mode: ps.mode || null,
          error: ps.error || null,
          ip: ip,
          probe: st,
          lastPeer: (st && st.ok && st.host) ? st.host : (d.lastPeer || null)
        });
      }

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
