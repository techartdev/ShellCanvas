// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import type { SystemAPI } from "../system-api";
import type { AppPackage } from "./package";
import { RpcPeer, RpcError, messagePortTransport, type Json } from "./rpc";
import { systemMethods } from "./system-bridge";
import { fileMethods, type AppFileSourceGetter } from "./file-bridge";
import { AppDirectories } from "./directory-bridge";
import { AppConsoles, type AppConsoleSourceGetter } from "./console-bridge";
import { AppTransfers, type AppTransferSourceGetter } from "./transfer-bridge";
import {
  AppHostSettings,
  type AppHostSettingsSourceGetter,
} from "./host-settings-bridge";
import type { AppLease } from "./catalog";
import {
  documentStateMethod,
  windowMethods,
  type WindowControls,
  type AppDocumentState,
} from "./window-api";
import { isFrameHandshake, mountAppDocument } from "./frame-document";
import { appStorageMethods } from "./app-storage";
import type { AppStorageBackend } from "./storage-api";
import { AppEventJournal } from "./app-events";
import {
  RuntimeEnvironment,
  discoverMethods,
  emptyOptions,
  methodAvailable,
} from "./environment";
import { appCapabilities } from "./permissions";
import type { ClipboardService } from "../clipboard";
import { AppClipboard } from "./clipboard-api";
import { customMethods } from "./custom-bridge";
import type { CustomAccess } from "../custom-services";

/** Isolated app document shared by the desktop and development workbenches.
 * One effect owns one document, port and system handle. A prop change retires that instance.
 */
export function ExtensionFrame({
  app,
  system,
  grants,
  lease,
  onDocumentState,
  windowControls,
  storage,
  clipboard,
  environment: suppliedEnvironment,
  custom,
  fileSource,
  consoleSource,
  transferSource,
  hostSettingsSource,
}: {
  app: AppPackage;
  system: SystemAPI;
  grants: readonly string[];
  lease?: AppLease;
  onDocumentState?: (state: AppDocumentState) => void;
  windowControls?: WindowControls;
  storage?: AppStorageBackend;
  clipboard?: ClipboardService;
  environment?: RuntimeEnvironment;
  custom?: CustomAccess;
  fileSource?: AppFileSourceGetter;
  consoleSource?: AppConsoleSourceGetter;
  transferSource?: AppTransferSourceGetter;
  hostSettingsSource?: AppHostSettingsSourceGetter;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  const [transferFailure, setTransferFailure] = useState<{
    message: string;
    retry(): Promise<void>;
  } | null>(null);
  const [retryingTransfers, setRetryingTransfers] = useState(false);
  const documentState = useRef(onDocumentState);
  const controls = useRef(windowControls);
  controls.current = windowControls;
  const [fallbackEnvironment] = useState(() => new RuntimeEnvironment());
  const environment = suppliedEnvironment ?? fallbackEnvironment;
  documentState.current = onDocumentState;
  useEffect(() => {
    const frame = ref.current!;
    if (lease?.closed) return;
    const token = crypto.randomUUID();
    let peer: RpcPeer | undefined;
    let connected = false;
    let retired = false;
    const events = new AppEventJournal([
      "system.environment",
      "system.services",
    ]);
    let stopEnvironment: (() => void) | undefined;
    const clipboardOwner = clipboard ? new AppClipboard(clipboard) : undefined;
    const directories = fileSource ? new AppDirectories(fileSource) : undefined;
    const consoles = consoleSource
      ? new AppConsoles(consoleSource, setError)
      : undefined;
    let appDocument: AppDocumentState = { dirty: false, busy: false };
    let transferBusy = false;
    let settingsBusy = false;
    const publishDocument = () =>
      documentState.current?.({
        ...appDocument,
        busy: appDocument.busy || transferBusy || settingsBusy,
      });
    const hostSettings = hostSettingsSource
      ? new AppHostSettings(
          hostSettingsSource,
          () => {
            const state = environment.snapshot();
            return (
              state.connection === "connected" &&
              state.capabilities.includes("host.settings")
            );
          },
          (busy) => {
            settingsBusy = busy;
            publishDocument();
          },
        )
      : undefined;
    const transfers: AppTransfers | undefined = transferSource
      ? new AppTransfers(
          transferSource,
          (capability) => {
            const state = environment.snapshot();
            return (
              state.connection === "connected" &&
              state.capabilities.includes(capability)
            );
          },
          (busy) => {
            transferBusy = busy;
            publishDocument();
          },
          (message) => {
            if (!retired)
              setTransferFailure({
                message,
                retry: async () => {
                  await transfers!.retryCleanup();
                },
              });
          },
        )
      : undefined;
    const receive = (event: MessageEvent) => {
      if (
        retired ||
        event.source !== frame.contentWindow ||
        !isFrameHandshake(event.data, "ready", token)
      )
        return;
      if (connected) {
        peer?.close();
        return;
      }
      connected = true;
      const channel = new MessageChannel();
      // Grants come from the host, and are intersected with the package declaration.
      const approved = grants.filter((grant) =>
        app.permissions.includes(grant),
      );
      const methods = new Map(systemMethods(system, approved));
      for (const [name, method] of windowMethods(() => controls.current))
        methods.set(name, method);
      if (fileSource)
        for (const [name, method] of fileMethods(fileSource))
          methods.set(name, method);
      if (directories)
        for (const [name, method] of directories.methods())
          methods.set(name, method);
      if (consoles)
        for (const [name, method] of consoles.methods())
          methods.set(name, method);
      if (transfers)
        for (const [name, method] of transfers.methods())
          methods.set(name, method);
      if (hostSettings)
        for (const [name, method] of hostSettings.methods())
          methods.set(name, method);
      const customService = customMethods(
        custom,
        approved,
        () => environment.snapshot().connection === "connected",
      );
      methods.set("system.services.call", customService.call);
      if (storage)
        for (const [name, method] of appStorageMethods(app.id, storage))
          methods.set(name, method);
      if (clipboardOwner)
        for (const [name, method] of clipboardOwner.methods())
          methods.set(name, method);
      methods.set(
        "system.window.setDocumentState",
        documentStateMethod((state) => {
          appDocument = state;
          publishDocument();
        }),
      );
      for (const [name, method] of methods) {
        const remote = appCapabilities(method.grants);
        if (remote.length && suppliedEnvironment)
          methods.set(name, {
            ...method,
            available: () => {
              const state = environment.snapshot();
              return methodAvailable(method, state, remote);
            },
          });
      }
      methods.set("system.environment.get", {
        grants: [],
        invoke: (params) => {
          emptyOptions(params);
          return environment.snapshot() as unknown as Json;
        },
      });
      methods.set("system.services.list", {
        grants: [],
        invoke: async (params, signal) => {
          emptyOptions(params);
          return [
            ...discoverMethods(methods, approved),
            ...(await customService.list(signal)),
          ] as unknown as Json;
        },
      });
      methods.set("system.events.next", {
        grants: [],
        invoke: async (params, signal) => {
          if (
            !params ||
            typeof params !== "object" ||
            Array.isArray(params) ||
            Object.keys(params).some((key) => key !== "after") ||
            (params.after !== null && typeof params.after !== "number")
          )
            throw new RpcError("invalid", "Supply an event cursor or null.");
          return (await events.next(params.after, signal)) as unknown as Json;
        },
      });
      const publishEnvironment = () => {
        transfers?.refresh();
        directories?.refresh(environment.snapshot().connection === "connected");
        const state = environment.snapshot();
        consoles?.refresh(
          state.connection === "connected" &&
            state.capabilities.includes("terminal"),
        );
        events.publish(
          "system.environment",
          environment.snapshot() as unknown as Json,
        );
        events.publish("system.services", null);
      };
      publishEnvironment();
      stopEnvironment = environment.subscribe(publishEnvironment);
      peer = new RpcPeer(
        messagePortTransport(channel.port1),
        methods,
        approved,
      );
      peer.onClose(() => {
        hostSettings?.close();
        transfers?.close();
        consoles?.close();
        directories?.close();
        clipboardOwner?.close();
        stopEnvironment?.();
        events.close();
      });
      frame.contentWindow!.postMessage(
        { type: "shellcanvas:connect:v1", token },
        "*",
        [channel.port2],
      );
    };
    window.addEventListener("message", receive);
    setError("");
    setTransferFailure(null);
    const unmount = mountAppDocument(frame, app, token, setError);
    const retire = () => {
      hostSettings?.close();
      transfers?.close();
      consoles?.close();
      directories?.close();
      retired = true;
      window.removeEventListener("message", receive);
      peer?.close();
      stopEnvironment?.();
      events.close();
      clipboardOwner?.close();
      unmount();
    };
    const stop = lease?.onClose(retire);
    return () => {
      stop?.();
      retire();
    };
  }, [
    app,
    system,
    grants,
    lease,
    storage,
    clipboard,
    environment,
    suppliedEnvironment,
    custom,
    fileSource,
    consoleSource,
    transferSource,
    hostSettingsSource,
  ]);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {transferFailure && (
        <div role="alert" className="runtime-connection-review">
          <span>{transferFailure.message}</span>
          <button
            disabled={retryingTransfers}
            onClick={async () => {
              setRetryingTransfers(true);
              try {
                await transferFailure.retry();
                setTransferFailure((current) =>
                  current === transferFailure ? null : current,
                );
              } catch (error) {
                setTransferFailure((current) =>
                  current === transferFailure
                    ? { ...current, message: String(error) }
                    : current,
                );
              } finally {
                setRetryingTransfers(false);
              }
            }}
          >
            {retryingTransfers
              ? "Releasing transfers…"
              : "Retry transfer cleanup"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" style={{ padding: 20 }}>
          {error}
        </p>
      )}
      <iframe
        ref={ref}
        title={app.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        style={{
          border: 0,
          width: "100%",
          flex: 1,
          minHeight: 0,
          display: error ? "none" : undefined,
        }}
      />
    </div>
  );
}
