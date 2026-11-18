(() => {
  try {
    Object.defineProperty(Document.prototype, "hidden", {
      get: () => false,
      configurable: true
    });
    Object.defineProperty(Document.prototype, "visibilityState", {
      get: () => "visible",
      configurable: true
    });
    Object.defineProperty(Document.prototype, "webkitVisibilityState", {
      get: () => "visible",
      configurable: true
    });
    Document.prototype.hasFocus = () => true;
  } catch (e) {}

  const stopEvent = (e) => {
    e.stopImmediatePropagation();
    e.stopPropagation();
  };

  [
    "blur",
    "focusout",
    "visibilitychange",
    "webkitvisibilitychange",
    "mouseleave",
    "pagehide"
  ].forEach((evt) => {
    window.addEventListener(evt, stopEvent, true);
    document.addEventListener(evt, stopEvent, true);
  });

  try {
    Object.defineProperty(window, "onblur", {
      get: () => null,
      set: () => {},
      configurable: true
    });
  } catch (e) {}
})();
