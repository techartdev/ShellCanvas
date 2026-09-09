// SPDX-License-Identifier: MPL-2.0
import { RpcError } from "./rpc";

/** The browser releases a held Web Lock if its owning context closes or crashes. */
export function holdCatalogLock(
  catalog: string,
  app: string,
  mode: "shared" | "exclusive",
  locks: LockManager | undefined = globalThis.navigator?.locks,
): Promise<() => void> {
  if (!locks)
    return Promise.reject(
      new RpcError(
        "unavailable",
        "This system cannot coordinate running apps. Update the browser or desktop runtime and try again.",
      ),
    );
  return new Promise((resolve, reject) => {
    void locks
      .request(
        `shellcanvas:apps:${JSON.stringify([catalog, app])}`,
        { mode, ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new RpcError(
              "busy",
              mode === "exclusive"
                ? "Close this app's running windows in all desktop instances before removing it. Disable it to prevent new launches."
                : "This app is being removed in another desktop instance. Refresh and try again.",
            );
          await new Promise<void>((release) => resolve(release));
        },
      )
      .catch(reject);
  });
}

/** Notifications carry no packages or grants; authoritative state remains in IndexedDB. */
export function catalogNotifications(name: string) {
  const topic = `shellcanvas:catalog:${name}`;
  return {
    changed() {
      if (typeof BroadcastChannel === "undefined") return;
      const channel = new BroadcastChannel(topic);
      channel.postMessage(null);
      channel.close();
    },
    subscribe(changed: () => void) {
      let channel: BroadcastChannel | undefined;
      try {
        if (typeof BroadcastChannel !== "undefined")
          channel = new BroadcastChannel(topic);
      } catch {
        /* Focus and polling remain available if broadcast is restricted. */
      }
      if (channel) channel.onmessage = changed;
      const visible = () => {
        if (document.visibilityState === "visible") changed();
      };
      window.addEventListener("focus", changed);
      document.addEventListener("visibilitychange", visible);
      // Also recover after missed delivery or a suspended/background desktop.
      const timer = window.setInterval(changed, 30_000);
      return () => {
        channel?.close();
        clearInterval(timer);
        window.removeEventListener("focus", changed);
        document.removeEventListener("visibilitychange", visible);
      };
    },
  };
}
