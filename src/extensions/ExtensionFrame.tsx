// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import type { SystemAPI } from "../system-api";
import type { AppPackage } from "./package";
import { RpcPeer, messagePortTransport } from "./rpc";
import { systemMethods } from "./system-bridge";
import type { AppLease } from "./catalog";
import { documentStateMethod, type AppDocumentState } from "./window-api";
import { isFrameHandshake, mountAppDocument } from "./frame-document";
import { appStorageMethods } from "./app-storage";
import type { AppStorageBackend } from "./storage-api";

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
}: {
  app: AppPackage;
  system: SystemAPI;
  grants: readonly string[];
  lease?: AppLease;
  onDocumentState?: (state: AppDocumentState) => void;
  storage?: AppStorageBackend;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState("");
  const documentState = useRef(onDocumentState);
  documentState.current = onDocumentState;
  useEffect(() => {
    const frame = ref.current!;
    if (lease?.closed) return;
    const token = crypto.randomUUID();
    let peer: RpcPeer | undefined;
    let connected = false;
    let retired = false;
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
      peer = new RpcPeer(
        messagePortTransport(channel.port1),
        methods,
        approved,
      );
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
      unmount();
    };
    const stop = lease?.onClose(retire);
    return () => {
      stop?.();
      retire();
    };
  }, [app, system, grants, lease, storage]);
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
