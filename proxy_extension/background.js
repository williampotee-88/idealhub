// Background service worker: owns the proxy switch state and the heartbeat.

// scheme socks5 -> Chrome/Edge resolve DNS remotely by default (no local leak).
// proxyDNS:true is honored by Firefox (forces remote DNS); Chrome ignores it safely.
const PROXY = { scheme: "socks5", host: "127.0.0.1", port: 10800, proxyDNS: true };

// A's status endpoints. The proxy port answers /api/status itself, so the
// single UU mapping (B:10800 -> A:10800) is enough; 10801 is a legacy fallback.
const STATUS_URLS = [
  "http://127.0.0.1:10800/api/status",
  "http://127.0.0.1:10801/api/status"
];

// Report this browser's terminal name to A so A's dashboard can list which
// machines are borrowing its network. Runs even when the popup is closed.
async function heartbeat() {
  let d = {};
  try {
    d = await chrome.storage.local.get(["enabled", "clientName"]);
  } catch (e) {
    return;
  }
  if (!d.enabled) return;  // not borrowing A's network -> don't register
  const name = d.clientName || "未命名终端";
  for (const u of STATUS_URLS) {
    try {
      const r = await fetch(u + "?client=" + encodeURIComponent(name),
                            { signal: AbortSignal.timeout(4000) });
      if (r.ok) return;    // registered on this endpoint, done
    } catch (e) { /* try the next endpoint */ }
  }
}

// MV3 service workers are killed when idle, so use alarms (survives sleep).
chrome.alarms.create("heartbeat", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "heartbeat") heartbeat();
});
chrome.runtime.onInstalled.addListener(heartbeat);
chrome.runtime.onStartup.addListener(heartbeat);

async function apply(on) {
  if (on) {
    await chrome.proxy.settings.set({
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: PROXY,
          // Keep local addresses direct so the dashboard / LAN pages work.
          bypassList: ["<-loopback>", "127.0.0.1", "localhost"]
        }
      },
      scope: "regular"
    });
  } else {
    await chrome.proxy.settings.clear({ scope: "regular" });
  }
}

// Restore last state on startup.
chrome.storage.local.get("enabled", (d) => {
  if (d.enabled) apply(true);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get") {
    chrome.storage.local.get("enabled", (d) =>
      sendResponse({ enabled: !!d.enabled })
    );
    return true;
  }
  if (msg.type === "toggle") {
    chrome.storage.local.get("enabled", (d) => {
      const next = !d.enabled;
      apply(next).then(() => {
        chrome.storage.local.set({ enabled: next });
        sendResponse({ enabled: next });
      });
    });
    return true;
  }
});
