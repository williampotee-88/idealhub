// Background service worker: owns the proxy switch state.

// scheme socks5 -> Chrome/Edge resolve DNS remotely by default (no local leak).
// proxyDNS:true is honored by Firefox (forces remote DNS); Chrome ignores it safely.
const PROXY = { scheme: "socks5", host: "127.0.0.1", port: 10800, proxyDNS: true };

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
