// Tells the Mac app when a text field in the panel gains or loses focus, so its
// window takes the keyboard only while you type (notes, a rename, Ask AI) and
// the call app keeps focus otherwise: native `focus {editing}`. The fields are
// inside the panel's shadow root, so this looks through it.
//
// A press on a text field asks every time: after a click into the call app the
// field still has focus in the page, but the window is no longer key. The press
// is also sent first because a page in a window that isn't key may not report
// focus until it is.
(function (root) {
  const call = (editing) => {
    try {
      Promise.resolve(root.earshotNative?.call("focus", { editing })).catch(() => {});
    } catch {}
  };
  const NOT_TEXT = ["button", "checkbox", "radio", "submit", "reset", "file", "range", "color", "image"];
  const editable = (el) => !!el && (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !NOT_TEXT.includes(el.type)));
  const deepActive = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  let last = null;
  const tell = (editing, always = false) => {
    if (editing === last && !always) return;
    last = editing;
    call(editing);
  };
  const check = () => setTimeout(() => tell(editable(deepActive())), 0);
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (editable(e.composedPath()[0])) tell(true, true);
      else check();
    },
    true
  );
  document.addEventListener("focusin", check, true);
  document.addEventListener("focusout", check, true);
})(typeof self !== "undefined" ? self : globalThis);
