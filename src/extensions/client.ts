// SPDX-License-Identifier: MPL-2.0
import type { SystemAPI } from "../system-api";
import { RpcPeer, messagePortTransport, type Json } from "./rpc";
export interface ExtensionClient {
  readonly system: SystemAPI;
  /** Namespaced services use the same broker; method availability never implies permission. */
  call(method: string, params?: Json, signal?: AbortSignal): Promise<Json>;
  dispose(): void;
}
export function connectToShellCanvas(
  timeoutMs = 10000,
): Promise<ExtensionClient> {
  return new Promise((resolve, reject) => {
    if (window.parent === window) {
      reject(new Error("Launch this app inside ShellCanvas."));
      return;
    }
    const timer = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("ShellCanvas did not establish an app channel."));
    }, timeoutMs);
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.data !== "shellcanvas:connect:v1" ||
        event.ports.length !== 1
      )
        return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      const peer = new RpcPeer(messagePortTransport(event.ports[0]));
      let lastFocus: Element | null = document.activeElement;
      const rememberFocus = (event: FocusEvent) => {
        if (
          event.target instanceof HTMLElement &&
          event.target !== document.body
        )
          lastFocus = event.target;
      };
      document.addEventListener("focusin", rememberFocus);
      const dispose = () => {
        document.removeEventListener("focusin", rememberFocus);
        window.removeEventListener("pagehide", dispose);
        peer.close();
      };
      const call = async (
        method: string,
        params: unknown,
        signal?: AbortSignal,
      ) => {
        const origin =
          document.activeElement === document.body
            ? lastFocus
            : document.activeElement;
        try {
          return await peer.call(
            method,
            JSON.parse(JSON.stringify(params)) as Json,
            signal,
          );
        } finally {
          // The parent can restore focus to the iframe; the child owns its actual control.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (
                !peer.isClosed &&
                origin instanceof HTMLElement &&
                origin.isConnected
              )
                origin.focus();
            }),
          );
        }
      };
      const system: SystemAPI = Object.freeze({
        apiVersion: 1,
        dialogs: Object.freeze({
          messageBox: async (options, control) =>
            (await call(
              "system.dialogs.messageBox",
              options,
              control?.signal,
            )) as Awaited<ReturnType<SystemAPI["dialogs"]["messageBox"]>>,
          openFile: async (options = {}, control) =>
            (await call(
              "system.dialogs.openFile",
              options,
              control?.signal,
            )) as Awaited<ReturnType<SystemAPI["dialogs"]["openFile"]>>,
          saveFile: async (options = {}, control) =>
            (await call(
              "system.dialogs.saveFile",
              options,
              control?.signal,
            )) as Awaited<ReturnType<SystemAPI["dialogs"]["saveFile"]>>,
        } satisfies SystemAPI["dialogs"]),
        files: Object.freeze({
          saveTextAs: async (options, control) =>
            (await call(
              "system.files.saveTextAs",
              options,
              control?.signal,
            )) as unknown as Awaited<
              ReturnType<SystemAPI["files"]["saveTextAs"]>
            >,
        } satisfies SystemAPI["files"]),
      });
      window.addEventListener("pagehide", dispose, { once: true });
      resolve({
        system,
        call: (method, params, signal) => peer.call(method, params, signal),
        dispose,
      });
    };
    window.addEventListener("message", receive);
    window.parent.postMessage("shellcanvas:ready:v1", "*");
  });
}
