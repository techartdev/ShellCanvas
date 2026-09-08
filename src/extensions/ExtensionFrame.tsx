// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef } from "react";
import type { SystemAPI } from "../system-api";
import { appDocument, type AppPackage } from "./package";
import { RpcPeer, messagePortTransport } from "./rpc";
import { systemMethods } from "./system-bridge";
import type { AppLease } from "./catalog";
import { documentStateMethod, type AppDocumentState } from "./window-api";

/** Experimental host, currently exercised only by the development fixture.
 * One effect owns one document, port and system handle. A prop change retires that instance.
 */
export function ExtensionFrame({
  app,
  system,
  grants,
  lease,
  onDocumentState,
}: {
  app: AppPackage;
  system: SystemAPI;
  grants: readonly string[];
  lease?: AppLease;
  onDocumentState?: (state: AppDocumentState) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const documentState = useRef(onDocumentState);
  documentState.current = onDocumentState;
  useEffect(() => {
    const frame = ref.current!;
    if (lease?.closed) return;
    let peer: RpcPeer | undefined;
    let connected = false;
    let retired = false;
    const receive = (event: MessageEvent) => {
      if (
        retired ||
        event.source !== frame.contentWindow ||
        event.data !== "shellcanvas:ready:v1"
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
      methods.set(
        "system.window.setDocumentState",
        documentStateMethod((state) => documentState.current?.(state)),
      );
      peer = new RpcPeer(
        messagePortTransport(channel.port1),
        methods,
        approved,
      );
      frame.contentWindow!.postMessage("shellcanvas:connect:v1", "*", [
        channel.port2,
      ]);
    };
    window.addEventListener("message", receive);
    frame.srcdoc = appDocument(app, crypto.randomUUID());
    const retire = () => {
      retired = true;
      window.removeEventListener("message", receive);
      peer?.close();
      frame.srcdoc = "";
    };
    const stop = lease?.onClose(retire);
    return () => {
      stop?.();
      retire();
    };
  }, [app, system, grants, lease]);
  return (
    <iframe
      ref={ref}
      title={app.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      style={{ border: 0, width: "100%", height: "100%", minHeight: 280 }}
    />
  );
}
