// Runs in the meeting page (MAIN world). Zoom and Meet size their stage from
// window.innerWidth / clientWidth in script, so while the Earshot sidebar is
// docked (<html data-earshot-dock-js="340">) report the width left of it.
// Teams lays out from CSS alone, so the sidebar never sets this there.
(() => {
  if (window.__earshotLayout) return;
  window.__earshotLayout = true;

  const docked = () => Number(document.documentElement?.getAttribute("data-earshot-dock-js")) || 0;

  const innerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")?.get;
  if (innerWidth) {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      enumerable: true,
      get() {
        const real = innerWidth.call(window);
        const width = docked();
        return width ? Math.max(320, real - width) : real;
      },
    });
  }

  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")?.get;
  if (clientWidth) {
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      enumerable: true,
      get() {
        const real = clientWidth.call(this);
        const width = docked();
        if (width && (this === document.documentElement || this === document.body)) return Math.max(320, real - width);
        return real;
      },
    });
  }
})();
