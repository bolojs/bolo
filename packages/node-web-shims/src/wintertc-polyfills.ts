/**
 * WinterTC / ECMA-429 alignment polyfills.
 * These patch browser globals to match Node.js compatibility expectations.
 * Installed once at sandbox initialization.
 *
 * ponytail: call installNavigatorUserAgent() at container boot and
 * installUnhandledRejectionHandler(process.emit) after the process shim is ready.
 */

export const installNavigatorUserAgent = (): void => {
  if (typeof navigator !== "undefined") {
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (bolo; V8) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      writable: false,
      configurable: false,
    });
  }
};

/**
 * unhandledrejection mirror — fires Node.js process.emit('unhandledRejection').
 * Must be called after the process shim is initialized.
 * @param processEmiter — the process object's .emit method
 */
export const installUnhandledRejectionHandler = (
  processEmiter: (reason: unknown, promise: unknown) => void,
): void => {
  if (typeof window !== "undefined") {
    window.addEventListener("unhandledrejection", (event) => {
      // Mirror Node.js behavior: emit on the process shim
      processEmiter(event.reason, event.promise);
    });
  }
};
