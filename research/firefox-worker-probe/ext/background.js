// Background script for the probe extension.
//
// This extension is deliberately Firefox-only: Firefox MV3 uses an event page
// ("background": { "scripts": [...] }) rather than a service worker, so this
// manifest would not load in Chrome. That is fine — Chrome's answers for the
// same four CSP variants were already collected on issue #51, and this probe
// only exists to produce the Firefox column.
//
// Everything is reported through here rather than straight from the content
// script, because the page's own CSP could interfere with a content-script
// fetch. The background page runs under the extension's own principal.

const BASE = `http://127.0.0.1:${globalThis.PROBE_CONFIG.port}`;

async function post(path, payload) {
  try {
    await fetch(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { delivered: true };
  } catch (err) {
    // Nothing useful to do here; surface it in the extension console.
    console.error("probe report failed", path, err);
    return { delivered: false, error: String(err) };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.kind === "report") return post("/report", msg.rec);
  if (msg && msg.kind === "phase") return post("/phase", { name: msg.name, ...msg.extra });
  return undefined;
});
