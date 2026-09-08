// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { previewServices, previewSession } from "../../src/preview";
import {
  capabilityLabels,
  type Capability,
  type ServiceStatus,
  type HostServices,
} from "../../src/sdk";
import "../../src/styles.css";

let fileState: ServiceStatus["state"] = "available";
let consoleState: ServiceStatus["state"] = "available";
let terminalOpens = 0;
const snapshot = (): ServiceStatus[] =>
  (Object.keys(capabilityLabels) as Capability[]).map((capability) => {
    const terminal = capability === "terminal";
    const supported = terminal || capability === "files.read";
    return {
      capability,
      state: supported ? (terminal ? consoleState : fileState) : "unsupported",
      source: supported
        ? {
            instance: terminal ? 2 : 1,
            generation: 1,
            adapter: terminal ? "Serial fixture" : "FTP fixture",
          }
        : null,
      reason: supported
        ? (terminal ? consoleState : fileState) === "available"
          ? null
          : terminal
            ? "Console connection closed"
            : "File connection unavailable"
        : "This fixture provides browsing and console only",
    };
  });
const initial = {
  ...previewSession,
  services: snapshot(),
  info: {
    ...previewSession.info,
    hostname: "mixed-device",
    system: "Mixed services fixture",
    capabilities: ["terminal", "files.read"] as Capability[],
  },
};
const backend: HostServices = {
  ...previewServices,
  status: async () => ({
    connected: consoleState === "available" || fileState === "available",
    services: snapshot(),
  }),
  terminal: async (_, __, ___, onEvent) => {
    terminalOpens++;
    onEvent({
      type: "output",
      data: Array.from(
        new TextEncoder().encode("Independent console ready\r\n> "),
      ),
    });
    return {
      close: async () => {},
      resize: async () => {},
      write: async (data) =>
        onEvent({
          type: "output",
          data: Array.from(
            typeof data === "string" ? new TextEncoder().encode(data) : data,
          ),
        }),
    };
  },
  list: async (id, path) => {
    if (fileState !== "available")
      throw new Error("File connection unavailable");
    return previewServices.list(id, path);
  },
};
function Fixture() {
  const [mode, setMode] = useState("Both connections available");
  return (
    <>
      <App services={backend} initialSession={initial} isNative={true} />
      <aside
        style={{
          position: "fixed",
          bottom: 10,
          left: 12,
          zIndex: 2000,
          display: "flex",
          gap: 8,
          alignItems: "center",
          background: "#182c38",
          padding: 10,
          borderRadius: 10,
        }}
      >
        <button
          onClick={() => {
            fileState = "disconnected";
            setMode("Files disconnected");
          }}
        >
          Disconnect files
        </button>
        <button
          onClick={() => {
            fileState = "available";
            setMode("Files available");
          }}
        >
          Restore files
        </button>
        <button
          onClick={() => {
            consoleState = "disconnected";
            setMode("Console disconnected");
          }}
        >
          Disconnect console
        </button>
        <button onClick={() => setMode(`Terminal opens: ${terminalOpens}`)}>
          Inspect console count
        </button>
        <span role="status">{mode}</span>
      </aside>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
