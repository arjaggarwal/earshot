// Runs in the extension's isolated world in every meeting-site frame. Passes events
// from the page hook to the background worker, and commands back to the hook.
(() => {
  if (window.__earshotBridge) return;
  window.__earshotBridge = true;

  // Teams stays on one page across calls, so remember per meeting.
  const askedForCaptions = new Set();

  function toPage(cmd) {
    document.documentElement.dispatchEvent(new CustomEvent("earshot:cmd", { detail: JSON.stringify(cmd) }));
  }

  async function maybeTurnOnCaptions(ref) {
    if (askedForCaptions.has(ref)) return;
    askedForCaptions.add(ref);
    const { autoCaptions = true, captionLanguage = "en" } = await chrome.storage.local.get(["autoCaptions", "captionLanguage"]);
    if (autoCaptions) toPage({ type: "enable-captions", language: Earshot.languageById(captionLanguage) });
  }

  // After Earshot is reloaded or updated, this copy in an already-open tab
  // loses its extension, and sending then throws at once ("Extension context
  // invalidated") instead of failing quietly. Stop listening instead; reloading
  // the tab brings in the new version.
  const alive = () => !!chrome.runtime?.id;

  document.documentElement.addEventListener("earshot:page", function onPage(event) {
    if (!alive()) return document.documentElement.removeEventListener("earshot:page", onPage);
    let msg;
    try {
      msg = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (msg.type === "join-status" && msg.status === "joined") maybeTurnOnCaptions(msg.ref);
    // Rejoining the same meeting needs captions asked for again.
    else if (msg.type === "join-status") askedForCaptions.delete(msg.ref);
    try {
      chrome.runtime.sendMessage({ kind: "page-event", msg }).catch(() => {});
    } catch {}
  });

  chrome.runtime.onMessage.addListener((req) => {
    if (req.kind === "page-cmd") toPage(req.cmd);
  });

  // This copy may have arrived after the meeting started (Earshot reloaded or updated with the
  // tab open), when the hook's "joined" has already gone by. Ask the hook to say it again.
  toPage({ type: "resync" });

  // Teams can stop its page's timers; a heartbeat from here is one more thing that keeps the
  // hook's call check running (see keepChecking in teams/page-hook.js).
  if (window.top === window && /(^|\.)teams\.(microsoft\.com|live\.com|cloud\.microsoft)$/.test(location.hostname)) {
    const beat = setInterval(() => (alive() ? toPage({ type: "heartbeat" }) : clearInterval(beat)), 1000);
  }
})();
