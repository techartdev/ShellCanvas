// SPDX-License-Identifier: MPL-2.0
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { clipboard } from "../../src/clipboard";
import { previewServices, previewSession } from "../../src/preview";
import type {
  Directory,
  FileEntry,
  HostServices,
  Session,
  TextDocument,
} from "../../src/sdk";
import "../../src/styles.css";
const sessions = new Map<number, Session>();
const documents = new Map<string, TextDocument>();
const folders = new Map<string, Directory>();
async function folder(id: number, path: string) {
  if (!sessions.has(id)) throw new Error("Fixture session closed");
  const key = `${id}:${path}`;
  if (!folders.has(key)) {
    const initial = await previewServices.list(id, path);
    folders.set(key, {
      ...initial,
      entries: initial.entries.map((entry) => ({ ...entry, revision: "1" })),
    });
  }
  return folders.get(key)!;
}
async function findEntry(id: number, path: string, revision: string) {
  const parent = await folder(id, path.slice(0, path.lastIndexOf("/")) || "/");
  const entry = parent.entries.find((entry) => entry.path === path);
  if (!entry || entry.revision !== revision)
    throw new Error("CONFLICT: Refresh the folder before changing this item.");
  return { parent, entry };
}
const first: Session = {
  ...previewSession,
  id: 101,
  info: {
    ...previewSession.info,
    hostname: "fixture-alpha",
    capabilities: [
      "terminal",
      "files.read",
      "files.edit",
      "files.create",
      "files.manage",
    ],
  },
};
sessions.set(first.id, first);
let next = 101;
let log: (text: string) => void = () => {};
clipboard.writeText = async (text) => {
  log(`copied: ${text}`);
};
clipboard.readText = async () => "/from-clipboard";
const backend: HostServices = {
  ...previewServices,
  createText: async (id, parent, name, text) => {
    const directory = await folder(id, parent);
    if (directory.entries.some((entry) => entry.name === name))
      throw new Error("An item already exists. Choose a different name.");
    const path = `${parent.replace(/\/$/, "")}/${name}`;
    const doc = { path, text, revision: "1", writable: true };
    directory.entries.push({
      name,
      path,
      kind: "file",
      size: new TextEncoder().encode(text).length,
      modified: 1,
      revision: "1",
    });
    documents.set(`${id}:${path}`, doc);
    log(`created ${path}`);
    return { ...doc };
  },
  makeDirectory: async (id, parent, name) => {
    const directory = await folder(id, parent);
    if (directory.entries.some((entry) => entry.name === name))
      throw new Error("An item already exists. Choose a different name.");
    const path = `${parent.replace(/\/$/, "")}/${name}`;
    directory.entries.push({
      name,
      path,
      kind: "directory",
      size: 0,
      modified: 1,
      revision: "1",
    });
    folders.set(`${id}:${path}`, { path, entries: [] });
    log(`folder created ${path}`);
    return path;
  },
  renameEntry: async (id, path, name, revision) => {
    const { parent, entry } = await findEntry(id, path, revision);
    if (parent.entries.some((entry) => entry.name === name))
      throw new Error("An item already exists. Choose a different name.");
    const destination = `${parent.path.replace(/\/$/, "")}/${name}`;
    entry.name = name;
    entry.path = destination;
    entry.revision = String(Number(entry.revision) + 1);
    const doc = documents.get(`${id}:${path}`);
    if (doc) {
      documents.delete(`${id}:${path}`);
      documents.set(`${id}:${destination}`, { ...doc, path: destination });
    }
    log(`renamed ${path} -> ${destination}`);
    return destination;
  },
  removeEntry: async (id, path, revision) => {
    const { parent, entry } = await findEntry(id, path, revision);
    if (entry.kind === "directory" && (await folder(id, path)).entries.length)
      throw new Error("Only empty folders can be deleted.");
    parent.entries = parent.entries.filter((entry) => entry.path !== path);
    documents.delete(`${id}:${path}`);
    log(`deleted ${path}`);
  },
  readText: async (id, path) => {
    if (!sessions.has(id)) throw new Error("Fixture session closed");
    const key = `${id}:${path}`;
    if (!documents.has(key))
      documents.set(key, {
        path,
        text: "# Fixture document\r\nHello from the remote file.\r\n",
        revision: "0",
        writable: true,
      });
    return { ...documents.get(key)! };
  },
  saveText: async (id, path, text, revision) => {
    if (!sessions.has(id)) throw new Error("Fixture session closed");
    const key = `${id}:${path}`,
      current = documents.get(key)!;
    if (current.revision !== revision)
      throw new Error(
        "CONFLICT: The remote file changed. Your draft is intact.",
      );
    const saved = { ...current, text, revision: String(Number(revision) + 1) };
    documents.set(key, saved);
    log(`saved ${path}`);
    return saved;
  },
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
    const result = await folder(id, path);
    return {
      ...result,
      entries: result.entries.map((entry: FileEntry) => ({ ...entry })),
    };
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
        <button
          onClick={() => {
            documents.forEach((doc, key) =>
              documents.set(key, {
                ...doc,
                text: "External fixture edit",
                revision: String(Number(doc.revision) + 1),
              }),
            );
          }}
        >
          Simulate remote edit
        </button>
        <button onClick={() => sessions.clear()}>
          Simulate connection loss
        </button>
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
