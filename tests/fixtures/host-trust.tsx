// SPDX-License-Identifier: MPL-2.0
// Synthetic review flow. No native access, real credentials or trust-file writes.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { previewServices, previewSession } from "../../src/preview";
import { clipboard } from "../../src/clipboard";
import type { HostServices } from "../../src/sdk";
import "../../src/styles.css";

let next = 600;
let log = (_text: string) => {};
let mode = "unknown";
const saved = new Set<string>();
clipboard.writeText = async (text) => {
  log(`copied ${text}`);
};
const backend: HostServices = {
  ...previewServices,
  profiles: async () => [
    {
      name: "Review fixture",
      host: "new.example.test",
      port: 2222,
      username: "fixture",
      keyPath: "/fixture/key",
    },
  ],
  connect: async (options, signal, review) => {
    log(`checking ${options.host}:${options.port}`);
    if (mode === "changed" || mode === "revoked")
      throw new Error(
        `${mode === "changed" ? "HOST KEY MISMATCH" : "REVOKED HOST KEY"}: connection refused.`,
      );
    const endpoint = `${options.host}:${options.port}`;
    if (!saved.has(endpoint)) {
      const pending =
        review?.({
          token: `fixture-${++next}`,
          host: options.host,
          port: options.port,
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:2qSTvpsrAznw1xB7daNLGNdZUJu7w8mQfG9VYhM0w4I",
        }) ?? Promise.resolve(false);
      const approved =
        mode === "expired"
          ? await Promise.race([
              pending,
              new Promise<boolean>((_, reject) =>
                setTimeout(
                  () => reject(new Error("Host-key review expired.")),
                  1500,
                ),
              ),
            ])
          : await pending;
      if (signal?.aborted) {
        log("canceled before trust");
        throw new Error("Connection canceled");
      }
      if (!approved) {
        log("trust rejected");
        throw new Error(
          "Host key was not trusted. No authentication was sent.",
        );
      }
      saved.add(endpoint);
      log(`trust saved ${endpoint}`);
      if (mode === "swap")
        throw new Error(
          "HOST KEY MISMATCH: key changed after review. No authentication was sent.",
        );
    }
    log(`authenticated ${endpoint}`);
    return {
      ...previewSession,
      id: ++next,
      info: { ...previewSession.info, hostname: options.host },
    };
  },
};
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  log = (text) => setEvents((old) => [...old.slice(-25), text]);
  return (
    <>
      <App services={backend} initialSession={null} isNative />
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
        <summary>Trust fixture</summary>
        <label>
          Mode{" "}
          <select
            aria-label="Trust fixture mode"
            onChange={(event) => {
              mode = event.target.value;
              saved.clear();
            }}
          >
            <option value="unknown">Unknown</option>
            <option value="changed">Changed</option>
            <option value="revoked">Revoked</option>
            <option value="expired">Expired</option>
            <option value="swap">Changed after review</option>
          </select>
        </label>
        <pre aria-label="Trust events">{events.join("\n")}</pre>
      </details>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
