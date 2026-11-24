// The parts of the extension's `chrome.*` API that content/sidebar.js uses,
// for the Mac app's web view:
//   chrome.runtime.id, sendMessage, onMessage, getURL, getManifest
//   chrome.storage.onChanged
// sendMessage goes to mac-background.js (the Mac panel's "background"), which
// answers the way extension/background.js does. getURL resolves under the
// folder panel.html was loaded from (Earshot.app/Contents/Resources/Web).
//
// The native bridge is one function, window.earshotNative.call(name, payload),
// which resolves with native's answer or rejects with its error. In the app it
// is webkit.messageHandlers.native.postMessage({name, payload}) (a handler
// with reply); a test can put its own earshotNative in place first.
(function (root) {
  const Earshot = (root.Earshot = root.Earshot || {});

  if (!root.earshotNative && root.webkit?.messageHandlers?.native) {
    root.earshotNative = { call: (name, payload = {}) => root.webkit.messageHandlers.native.postMessage({ name, payload }) };
  }

  const copy = (v) => (v === undefined ? v : structuredClone(v));
  const panelListeners = [];
  const storageListeners = [];
  let handler = null; // mac-background.js: (message) -> Promise<reply>

  const chrome = (root.chrome = root.chrome || {});
  chrome.runtime = {
    id: "earshot-mac",
    getURL: (file) => new URL(String(file).replace(/^\//, ""), document.baseURI).href,
    getManifest: () => ({ name: "Earshot for Mac", version: "mac" }),
    // Like Chrome: a reply, or undefined for kinds that don't answer; a failure
    // rejects. Messages and replies are copies, as Chrome's are: the panel
    // changes the objects it's given.
    sendMessage(message) {
      if (!handler) return Promise.reject(new Error("Earshot for Mac isn't ready"));
      return Promise.resolve()
        .then(() => handler(copy(message)))
        .then(copy);
    },
    onMessage: { addListener: (fn) => panelListeners.push(fn) },
  };
  chrome.storage = { onChanged: { addListener: (fn) => storageListeners.push(fn) } };

  Earshot.macShim = {
    setHandler(fn) {
      handler = fn;
    },
    // What extension/background.js sends a tab's panel: {kind: "overlay", type, ...}.
    toPanel(payload) {
      for (const fn of panelListeners) {
        try {
          fn(copy({ kind: "overlay", ...payload }), { id: chrome.runtime.id }, () => {});
        } catch (err) {
          console.error("Earshot panel:", err);
        }
      }
    },
    storageChanged(changes, area = "local") {
      for (const fn of storageListeners) fn(copy(changes), area);
    },
  };
})(typeof self !== "undefined" ? self : globalThis);
