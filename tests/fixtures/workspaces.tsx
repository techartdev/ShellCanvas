// SPDX-License-Identifier: MPL-2.0
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { previewServices, previewSession } from "../../src/preview";
import type { HostServices, Session } from "../../src/sdk";
import "../../src/styles.css";
const sessions = new Map<number, Session>();
const first: Session = {
  ...previewSession,
  id: 101,
  info: { ...previewSession.info, hostname: "fixture-alpha" },
};
sessions.set(first.id, first);
let next = 101;
let log: (text: string) => void = () => {};
const backend: HostServices = {
  ...previewServices,
  profiles: async () =>
    ["beta", "failure"].map((name) => ({
      name: `Fixture ${name}`,
      host: `${name}.example`,
      username: "fixture",
      port: 22,
      keyPath: "/fixture/key",
    })),
  connect: async (options) => {
    if (options.host === "failure.example")
      throw new Error("Fixture connection refused");
    const session = {
      ...first,
      id: ++next,
      info: {
        ...first.info,
        hostname: `fixture-${options.host.split(".")[0]}`,
      },
    };
    sessions.set(session.id, session);
    log(`connected ${session.id}`);
    return session;
  },
  disconnect: async (id) => {
    sessions.delete(id);
    log(`disconnected ${id}`);
  },
  alive: async (id) => sessions.has(id),
  list: async (id, path) => {
    if (!sessions.has(id)) throw new Error("Fixture session closed");
    return previewServices.list(id, path);
  },
  terminal: async (id, _, __, event) => {
    log(`shell opened ${id}`);
    const output = (text: string) =>
      event({ type: "output", data: [...new TextEncoder().encode(text)] });
    output(`Fixture shell ${id}\r\n`);
    return {
      write: async (text) => {
        if (!sessions.has(id)) throw new Error("Fixture session closed");
        log(`input ${id}: ${text}`);
        output(text);
      },
      resize: async () => {},
      close: async () => {
        log(`shell closed ${id}`);
      },
    };
  },
};
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  log = (text) => setEvents((old) => [...old.slice(-19), text]);
  return (
    <>
      <App services={backend} initialSession={first} isNative />
      <details
        style={{
          position: "fixed",
          bottom: 4,
          left: 10,
          zIndex: 100,
          background: "#172430",
          fontSize: 10,
        }}
      >
        <summary>Fixture events</summary>
        <pre aria-label="Fixture events">{events.join("\n")}</pre>
      </details>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
