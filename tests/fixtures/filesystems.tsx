// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { filesystemFixture, type FileFixture } from "./filesystem-provider";
import { clipboard } from "../../src/clipboard";
import "../../src/styles.css";
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  const [kind, setKind] = useState<FileFixture>("virtual");
  const [fixture, setFixture] = useState(() =>
    filesystemFixture("virtual", record),
  );
  const [clipboardText, setClipboardText] = useState(fixture.locations.child);
  const [rejectCopy, setRejectCopy] = useState(false);
  const [rejectPaste, setRejectPaste] = useState(false);
  function record(text: string) {
    setEvents((old) => [...old.slice(-29), text]);
  }
  clipboard.writeText = async (text) => {
    if (rejectCopy) throw new Error("Fixture clipboard write refused");
    setClipboardText(text);
    record(`copy ${text}`);
  };
  clipboard.readText = async () => {
    if (rejectPaste) throw new Error("Fixture clipboard read refused");
    record(`clipboard read ${clipboardText}`);
    return clipboardText;
  };
  return (
    <>
      <App
        key={kind}
        initialSession={fixture.session}
        services={fixture.backend}
      />
      <details
        style={{
          position: "fixed",
          zIndex: 100,
          bottom: 4,
          left: 10,
          background: "#172430",
          fontSize: 10,
        }}
      >
        <summary>Filesystem fixture</summary>
        <label>
          Path model{" "}
          <select
            aria-label="Path model"
            value={kind}
            onChange={(e) => {
              const value = e.target.value as FileFixture;
              setKind(value);
              const next = filesystemFixture(value, record);
              setFixture(next);
              setClipboardText(next.locations.child);
              setEvents([]);
            }}
          >
            <option value="unix">Unix</option>
            <option value="drives">Drive roots</option>
            <option value="virtual">Opaque locations</option>
          </select>
        </label>
        <label>
          Clipboard text{" "}
          <textarea
            aria-label="Fixture clipboard text"
            value={clipboardText}
            onChange={(event) => setClipboardText(event.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={rejectCopy}
            onChange={(event) => setRejectCopy(event.target.checked)}
          />{" "}
          Refuse clipboard copy
        </label>
        <label>
          <input
            type="checkbox"
            checked={rejectPaste}
            onChange={(event) => setRejectPaste(event.target.checked)}
          />{" "}
          Refuse clipboard paste
        </label>
        <pre aria-label="Filesystem events">{events.join("\n")}</pre>
      </details>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
