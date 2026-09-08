// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "../../src/apps/Terminal";
import { clipboard } from "../../src/clipboard";
import { previewServices, previewSession } from "../../src/preview";
import type { SessionServices } from "../../src/sdk";
import "../../src/styles.css";

// Real terminal/menu components with fake I/O and clipboard. No native access.
function Fixture() {
  const [small, setSmall] = useState(false);
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  clipboard.writeText = async (text) => {
    setCopied(text.includes("fixture line"));
  };
  clipboard.readText = async () => "fixture paste";
  const [services] = useState<SessionServices>(() => ({
    list: (path) => previewServices.list(previewSession.id, path),
    preview: (path) => previewServices.preview(previewSession.id, path),
    terminal: async (_, __, event) => {
      event({
        type: "output",
        data: Array.from(
          new TextEncoder().encode(
            Array.from({ length: 120 }, (_, i) => `fixture line ${i}\r\n`).join(
              "",
            ),
          ),
        ),
      });
      return {
        write: async (text) => {
          setInput((old) => old + text);
        },
        resize: async () => {},
        close: async () => {},
      };
    },
  }));
  return (
    <>
      <button onClick={() => setSmall(!small)}>Toggle terminal size</button>
      <p>
        Copied fixture text: {String(copied)} · Input: {JSON.stringify(input)} ·
        Error: {error || "none"}
      </p>
      <div
        style={{
          position: "absolute",
          top: 70,
          left: 20,
          width: "min(800px, calc(100vw - 40px))",
          height: small ? 260 : 500,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Terminal
          session={previewSession}
          services={services}
          preview={false}
          connect={() => {}}
          reportError={setError}
        />
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
