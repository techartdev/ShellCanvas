// SPDX-License-Identifier: MPL-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdapterDiagnosticsPanel } from "../../src/components/AdapterDiagnosticsPanel";
import type { AdapterServices } from "../../src/adapters";
import type { ConnectionDiagnostics } from "../../src/adapter-diagnostics";
import { clipboard } from "../../src/clipboard";
import "../../src/styles.css";
const failed: ConnectionDiagnostics = {
  schemaVersion: 1,
  status: "failed",
  connection: {
    instance: 42,
    generation: 1,
    adapter: "org.example.network-device",
  },
  attempt: 9,
  discardedEvents: 0,
  events: [
    "launchRequested",
    "spawned",
    "requestDispatched",
    "requestFailed",
    "closeRequested",
    "cleanupConfirmed",
    "initializationFailed",
  ].map((kind, index) => ({
    kind: kind as ConnectionDiagnostics["events"][number]["kind"],
    sequence: index + 1,
    elapsedMs: index * 42,
    requestId: index === 2 || index === 3 ? 1 : null,
    code:
      kind === "initializationFailed" || kind === "requestFailed"
        ? "denied"
        : null,
  })),
};
const connected: ConnectionDiagnostics = {
  ...failed,
  status: "connected",
  connection: { ...failed.connection, instance: 41 },
  discardedEvents: 244,
  events: Array.from({ length: 256 }, (_, index) => ({
    sequence: index + 245,
    elapsedMs: index * 22,
    kind: index % 2 ? "requestSucceeded" : "requestDispatched",
    requestId: Math.floor(index / 2) + 120,
    code: null,
  })),
};
const services = {
  diagnostics: async () => structuredClone([failed, connected]),
} as AdapterServices;
clipboard.writeText = async (text) => {
  document.getElementById("copy-status")!.textContent =
    `Copied ${JSON.parse(text).events.length} events from connection ${JSON.parse(text).connection.instance}.`;
};
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ maxWidth: 800, margin: "40px auto", padding: 24 }}>
      <h1>Connection could not start</h1>
      <p>
        The adapter refused initialization. Review its settings and try again.
      </p>
      <AdapterDiagnosticsPanel services={services} />
      <p id="copy-status" role="status" />
    </main>
  </StrictMode>,
);
