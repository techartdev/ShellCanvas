// SPDX-License-Identifier: MPL-2.0
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "../../src/apps/Editor";
import { bindSession } from "../../src/session-services";
import { previewServices, previewSession } from "../../src/preview";
import type { Session, TextDocument } from "../../src/sdk";
import "../../src/styles.css";

const session: Session = {
  ...previewSession,
  info: {
    ...previewSession.info,
    capabilities: ["files.read", "files.create", "files.edit"],
  },
};

function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  const [mode, setMode] = useState("normal");
  const [connected, setConnected] = useState(true);
  const nextMode = useRef(mode);
  nextMode.current = mode;
  const [remote, setRemote] = useState("Original destination");
  const services = useMemo(() => {
    const docs = new Map<string, TextDocument>([
      [
        "object@destination",
        {
          path: "object@destination",
          name: "existing.txt",
          parent: "node@root",
          text: "Original destination",
          revision: "r1",
          writable: true,
        },
      ],
    ]);
    const record = (text: string) => setEvents((old) => [...old, text]);
    return bindSession(
      {
        ...previewServices,
        list: async () => ({
          path: "node@root",
          name: "Root",
          parent: null,
          home: null,
          roots: [],
          entries: [...docs.values()].map((doc) => ({
            path: doc.path,
            name: doc.name,
            kind: "file" as const,
            size: doc.text.length,
            modified: null,
          })),
        }),
        readText: async (_, path) => {
          record(`read ${path}`);
          if (!docs.has(path)) throw new Error("Not found");
          return { ...docs.get(path)! };
        },
        saveText: async (_, path, text, revision) => {
          const doc = docs.get(path)!;
          record(`save ${path} revision ${revision}`);
          if (nextMode.current === "conflict") {
            doc.text = "External change";
            doc.revision = "external";
            setRemote(doc.text);
            nextMode.current = "normal";
            setMode("normal");
          } else if (nextMode.current === "denied")
            throw new Error("Permission denied");
          if (revision !== doc.revision)
            throw new Error(
              "CONFLICT: The remote file changed. Your draft has not been saved.",
            );
          Object.assign(doc, { text, revision: `${revision}+1` });
          setRemote(text);
          if (nextMode.current === "disconnect") {
            setConnected(false);
            setMode("normal");
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return { ...doc };
        },
        createText: async (_, parent, name, text) => {
          record(`create ${parent} name ${name}`);
          if ([...docs.values()].some((doc) => doc.name === name))
            throw new Error("Already exists");
          const doc = {
            path: `new@${docs.size}`,
            parent,
            name,
            text,
            revision: "r1",
            writable: true,
          };
          docs.set(doc.path, doc);
          return { ...doc };
        },
      },
      session,
    ).services;
  }, []);
  return (
    <>
      <div style={{ padding: 12 }}>
        <label>
          Next replacement{" "}
          <select
            aria-label="Replacement behavior"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="normal">Normal</option>
            <option value="conflict">External change</option>
            <option value="denied">Permission denied</option>
            <option value="disconnect">Disconnect after write</option>
          </select>
        </label>
        {!connected && (
          <button onClick={() => setConnected(true)}>Reconnect fixture</button>
        )}
        <pre aria-label="Remote contents">{remote}</pre>
        <pre aria-label="Save events">{events.join("\n")}</pre>
      </div>
      <div
        style={{
          position: "absolute",
          top: 180,
          left: 20,
          right: 20,
          bottom: 20,
          display: "flex",
        }}
      >
        <Editor
          preview
          session={session}
          services={services}
          launch={{ directory: "node@root" }}
          connected={connected}
          connect={() => {}}
          reportError={() => {}}
        />
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
