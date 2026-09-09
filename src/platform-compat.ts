// SPDX-License-Identifier: MPL-2.0
// Syntax lowering does not supply missing runtime APIs. Load before the desktop
// modules so older embedded WebKit can initialize the same app state safely.
import "core-js/actual/array/at";
import "core-js/actual/object/has-own";
import "core-js/actual/structured-clone";

// UUIDs remain cryptographically random on older WebKit. Never use Math.random
// for IDs that also identify broker requests, generations or frame ownership.
export function installRandomUUID(cryptoApi: Crypto): void {
  if (typeof cryptoApi.randomUUID === "function") return;
  Object.defineProperty(cryptoApi, "randomUUID", {
    configurable: true,
    writable: true,
    value: (): ReturnType<Crypto["randomUUID"]> => {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      );
      return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10).join(""),
      ].join("-") as ReturnType<Crypto["randomUUID"]>;
    },
  });
}

if (typeof globalThis.crypto !== "undefined")
  installRandomUUID(globalThis.crypto);

// The desktop/xterm use plain change callbacks without EventTarget options.
// Old WebKit has the equivalent addListener/removeListener pair. Bridge those
// calls on its shared prototype so disposing xterm removes the same callback.
export function installMediaQueryListeners(prototype: MediaQueryList): void {
  if (typeof prototype.addEventListener === "function") return;
  Object.defineProperties(prototype, {
    addEventListener: {
      configurable: true,
      writable: true,
      value: function (
        this: MediaQueryList,
        type: string,
        listener: MediaQueryList["onchange"],
      ) {
        if (type === "change" && listener) this.addListener(listener);
      },
    },
    removeEventListener: {
      configurable: true,
      writable: true,
      value: function (
        this: MediaQueryList,
        type: string,
        listener: MediaQueryList["onchange"],
      ) {
        if (type === "change" && listener) this.removeListener(listener);
      },
    },
  });
}

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  installMediaQueryListeners(
    Object.getPrototypeOf(window.matchMedia("(min-width: 0px)")),
  );
}

// CSS.supports("gap", "1px") also succeeds for engines that only support grid
// gaps. Measure a tiny flex layout before React mounts instead of sniffing UA.
if (typeof document !== "undefined" && document.body) {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px;";
  probe.append(document.createElement("div"), document.createElement("div"));
  document.body.append(probe);
  document.documentElement.classList.toggle(
    "legacy-flex-gap",
    probe.scrollHeight !== 1,
  );
  probe.remove();
}
