// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import type { SystemAPI } from "../system-api";
import type { AppPackage } from "./package";
import { RpcPeer, RpcError, messagePortTransport, type Json } from "./rpc";
import { systemMethods } from "./system-bridge";
import type { AppLease } from "./catalog";
import { documentStateMethod, type AppDocumentState } from "./window-api";
import { isFrameHandshake, mountAppDocument } from "./frame-document";
import { appStorageMethods } from "./app-storage";
import type { AppStorageBackend } from "./storage-api";
import { AppEventJournal } from "./app-events";
import {
  RuntimeEnvironment,
  discoverMethods,
  emptyOptions,
} from "./environment";
import { capabilityLabels } from "../sdk";

/** Isolated app document shared by the desktop and development workbenches.
 * One effect owns one document, port and system handle. A prop change retires that instance.
 */
export function ExtensionFrame({
  app,
  system,
  grants,
  lease,
  onDocumentState,
  storage,
  environment: suppliedEnvironment,
}: {
  app: AppPackage;
  system: SystemAPI;
  grants: readonly string[];
  lease?: AppLease;
  onDocumentState?: (state: AppDocumentState) => void;
  storage?: AppStorageBackend;
  environment?: RuntimeEnvironment;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  const documentState = useRef(onDocumentState);
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
      if (storage)
        for (const [name, method] of appStorageMethods(app.id, storage))
          methods.set(name, method);
      methods.set(
        "system.window.setDocumentState",
        documentStateMethod((state) => documentState.current?.(state)),
      );
      for (const [name, method] of methods) {
        const remote = method.grants.filter((grant) =>
          Object.hasOwn(capabilityLabels, grant),
        );
        if (remote.length && suppliedEnvironment)
          methods.set(name, {
            ...method,
            available: () => {
              const state = environment.snapshot();
              return (
                state.connection === "connected" &&
                remote.every((capability) =>
                  state.capabilities.includes(capability),
                )
              );
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
        invoke: (params) => {
          emptyOptions(params);
          return discoverMethods(methods, approved) as unknown as Json;
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
    const unmount = mountAppDocument(frame, app, token, setError);
    const retire = () => {
      retired = true;
      window.removeEventListener("message", receive);
      peer?.close();
      stopEnvironment?.();
      events.close();
      unmount();
    };
    const stop = lease?.onClose(retire);
    return () => {
      stop?.();
      retire();
    };
  }, [app, system, grants, lease, storage, environment, suppliedEnvironment]);
  return (
    <>
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
          height: "100%",
          minHeight: 280,
          display: error ? "none" : undefined,
        }}
      />
    </>
  );
}
