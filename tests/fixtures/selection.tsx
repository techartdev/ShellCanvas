// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Files } from "../../src/apps/Files";
import { clipboard } from "../../src/clipboard";
import { previewServices, previewSession } from "../../src/preview";
import { bindSession } from "../../src/session-services";
import type { FileEntry, Session } from "../../src/sdk";
import "../../src/styles.css";
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const release = useRef<(fail: boolean) => void>(() => {});
  useEffect(() => {
    const control = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey) return;
      if (event.code === "Digit1") release.current(false);
      else if (event.code === "Digit2") release.current(true);
      else if (event.code === "Digit3") setConnected(false);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", control);
    return () => window.removeEventListener("keydown", control);
  }, []);
  const entries = useRef<FileEntry[]>([
    ...["alpha.txt", "beta.txt", "gamma.txt", ".hidden"].map((name, i) => ({
      name,
      path: `opaque@${i}`,
      revision: `revision-${i}`,
      kind: "file" as const,
      size: i + 10,
      modified: null,
    })),
    {
      name: "Projects",
      path: "opaque@folder",
      revision: "folder-revision",
      kind: "directory",
      size: 0,
      modified: null,
    },
  ]);
  const record = (event: string) => setEvents((old) => [...old, event]);
  clipboard.writeText = async (text) => {
    record(`Clipboard: ${JSON.stringify(text)}`);
  };
  const [session] = useState<Session>(() => ({
    ...previewSession,
    info: {
      ...previewSession.info,
      capabilities: ["files.read", "files.manage"],
    },
  }));
  const [services] = useState(
    () =>
      bindSession(
        {
          ...previewServices,
          list: async () => ({
            path: "folder@root",
            name: "Selection workspace",
            parent: null,
            home: null,
            roots: [],
            entries: [...entries.current],
          }),
          removeEntry: async (_, path, revision) => {
            record(`Delete requested: ${path} (${revision})`);
            setPending(true);
            await new Promise<void>((resolve, reject) => {
              release.current = (fail) => {
                setPending(false);
                if (fail) reject(new Error("Permission denied"));
                else {
                  entries.current = entries.current.filter(
                    (entry) => entry.path !== path,
                  );
                  resolve();
                }
              };
            });
            record(`Deleted: ${path}`);
          },
        },
        session,
      ).services,
  );
  return (
    <>
      <div style={{ display: "flex", gap: 12, padding: 12 }}>
        <button disabled={!pending} onClick={() => release.current(false)}>
          Complete deletion
        </button>
        <button disabled={!pending} onClick={() => release.current(true)}>
          Fail deletion
        </button>
        <button onClick={() => setConnected((value) => !value)}>
          {connected ? "Lose file connection" : "Restore file connection"}
        </button>
        <output>Window busy: {String(busy)}</output>
        <small>
          Dialog controls: Ctrl+Shift+1 success · 2 failure · 3 connection loss
        </small>
      </div>
      <div style={{ display: "flex", gap: 12, padding: 12, height: 520 }}>
        {["Files A", "Files B"].map((name, index) => (
          <section
            key={name}
            aria-label={name}
            style={{
              display: "flex",
              width: "50%",
              border: "1px solid #668899",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <Files
              session={session}
              services={services}
              preview={false}
              connected={connected}
              connect={() => {}}
              reportError={record}
              setDocumentState={
                index === 0
                  ? (state) => setBusy(state.busy ?? false)
                  : undefined
              }
            />
          </section>
        ))}
      </div>
      <pre style={{ padding: 12, fontSize: 11 }}>{events.join("\n")}</pre>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
