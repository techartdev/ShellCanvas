// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef } from "react";
import type { SystemAPI } from "../system-api";
import { appDocument, type AppPackage } from "./package";
import { RpcPeer, messagePortTransport } from "./rpc";
import { systemMethods } from "./system-bridge";

/** Experimental host, currently exercised only by the development fixture.
 * One effect owns one document, port and system handle. A prop change retires that instance.
 */
export function ExtensionFrame({
  app,
  system,
  grants,
}: {
  app: AppPackage;
  system: SystemAPI;
  grants: readonly string[];
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const frame = ref.current!;
    let peer: RpcPeer | undefined;
    let connected = false;
    const receive = (event: MessageEvent) => {
      if (
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
      peer = new RpcPeer(
        messagePortTransport(channel.port1),
        systemMethods(system, approved),
        approved,
      );
      frame.contentWindow!.postMessage("shellcanvas:connect:v1", "*", [
        channel.port2,
      ]);
    };
    window.addEventListener("message", receive);
    frame.srcdoc = appDocument(app, crypto.randomUUID());
    return () => {
      window.removeEventListener("message", receive);
      peer?.close();
      frame.srcdoc = "";
    };
  }, [app, system, grants]);
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
