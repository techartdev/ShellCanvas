// SPDX-License-Identifier: MPL-2.0
import type { SystemAPI } from "../system-api";
import { RpcPeer, messagePortTransport, type Json } from "./rpc";
import type { AppDocumentState } from "./window-api";
import type { AppStorageAPI, AppValue, StoragePage } from "./storage-api";
import type {
  AppEnvironment,
  ServiceMethodInfo,
  AppEventsAPI,
} from "./environment-api";
import { appEventClient } from "./app-events";
export interface ExtensionClient {
  readonly system: SystemAPI;
  readonly window: { setDocumentState(state: AppDocumentState): Promise<void> };
  readonly storage: AppStorageAPI;
  readonly settings: AppStorageAPI;
  readonly environment: { get(signal?: AbortSignal): Promise<AppEnvironment> };
  readonly services: {
    list(signal?: AbortSignal): Promise<readonly ServiceMethodInfo[]>;
  };
  readonly events: AppEventsAPI;
  /** Namespaced services use the same broker; method availability never implies permission. */
  call(method: string, params?: Json, signal?: AbortSignal): Promise<Json>;
  dispose(): void;
}
export function connectToShellCanvas(
  timeoutMs = 10000,
): Promise<ExtensionClient> {
  return new Promise((resolve, reject) => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="shellcanvas-instance"]',
    )?.content;
    if (!token) {
      reject(new Error("Missing ShellCanvas instance identity."));
      return;
    }
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
        event.data?.type !== "shellcanvas:connect:v1" ||
        event.data?.token !== token ||
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
      const storage = (namespace: "storage" | "settings"): AppStorageAPI =>
        Object.freeze({
          get: async (key, signal) =>
            (await peer.call(
              `system.${namespace}.get`,
              { key },
              signal,
            )) as unknown as AppValue | null,
          put: async (key, value, expectedRevision, signal) =>
            (await peer.call(
              `system.${namespace}.put`,
              { key, value, expectedRevision },
              signal,
            )) as unknown as AppValue,
          remove: async (key, expectedRevision, signal) => {
            await peer.call(
              `system.${namespace}.remove`,
              { key, expectedRevision },
              signal,
            );
          },
          list: async (options = {}, signal) =>
            (await peer.call(
              `system.${namespace}.list`,
              JSON.parse(JSON.stringify(options)) as Json,
              signal,
            )) as unknown as StoragePage,
        } satisfies AppStorageAPI);
      resolve({
        system,
        storage: storage("storage"),
        settings: storage("settings"),
        environment: Object.freeze({
          get: async (signal?: AbortSignal) =>
            (await peer.call(
              "system.environment.get",
              null,
              signal,
            )) as unknown as AppEnvironment,
        }),
        services: Object.freeze({
          list: async (signal?: AbortSignal) =>
            (await peer.call(
              "system.services.list",
              null,
              signal,
            )) as unknown as readonly ServiceMethodInfo[],
        }),
        events: appEventClient(peer),
        window: Object.freeze({
          setDocumentState: async (state: AppDocumentState) => {
            await peer.call(
              "system.window.setDocumentState",
              JSON.parse(JSON.stringify(state)) as Json,
            );
          },
        }),
        call: (method, params, signal) => peer.call(method, params, signal),
        dispose,
      });
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "shellcanvas:ready:v1", token }, "*");
  });
}
