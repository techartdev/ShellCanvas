// SPDX-License-Identifier: MPL-2.0
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "../../src/apps/Editor";
import { clipboard } from "../../src/clipboard";
import { bindSession } from "../../src/session-services";
import { previewServices, previewSession } from "../../src/preview";
import type { Session } from "../../src/sdk";
import "../../src/styles.css";
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const release = useRef<(fail: boolean) => void>(() => {});
  const [visible, setVisible] = useState(true);
  const [session] = useState<Session>(() => ({
    ...previewSession,
    info: {
      ...previewSession.info,
      capabilities: ["files.read", "files.edit"],
    },
  }));
  const record = (event: string) => setEvents((old) => [...old, event]);
  const wait = () =>
    new Promise<void>((resolve, reject) => {
      setPending(true);
      release.current = (fail) => {
        setPending(false);
        fail ? reject(new Error("Fixture clipboard refused")) : resolve();
      };
    });
  clipboard.writeText = async (text) => {
    record(`Copy requested: ${text}`);
    await wait();
  };
  clipboard.readText = async () => {
    record("Paste requested");
    await wait();
    return "pasted\r\ntext";
  };
  const services = useMemo(
    () =>
      bindSession(
        {
          ...previewServices,
          readText: async (_, path) => {
            record(`Loaded ${path}`);
            return {
              path,
              name: path,
              parent: "root@1",
              text: "alpha beta",
              revision: "r1",
              writable: true,
            };
          },
          saveText: async (_, path, text) => {
            record(`Saved ${path}: ${text}`);
            return {
              path,
              name: path,
              parent: "root@1",
              text,
              revision: "r2",
              writable: true,
            };
          },
        },
        session,
      ).services,
    [session],
  );
  return (
    <>
      <div style={{ padding: 12, display: "flex", gap: 12 }}>
        <button disabled={!pending} onClick={() => release.current(false)}>
          Finish clipboard
        </button>
        <button disabled={!pending} onClick={() => release.current(true)}>
          Fail clipboard
        </button>
        <button onClick={() => setVisible((value) => !value)}>
          {visible ? "Unmount editor" : "Mount editor"}
        </button>
      </div>
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 20,
          width: 780,
          height: 490,
          display: "flex",
        }}
      >
        {visible && (
          <Editor
            session={session}
            services={services}
            launch={{ path: "document@a" }}
            preview={false}
            connect={() => {}}
            reportError={record}
          />
        )}
      </div>
      <pre style={{ position: "absolute", top: 570, left: 20, fontSize: 11 }}>
        {events.join("\n")}
      </pre>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
