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
import { posixRelocation } from "./posix-relocation";
const sessions = new Map<number, Session>();
const sessionHosts = new Map<number, string>([[101, "alpha.example"]]);
const fileKey = (id: number, path: string) =>
  `${sessionHosts.get(id) ?? id}:${path}`;
let nextWithoutFiles = false;
let denyNextFileChange = false;
let delayNextListing = false;
let failNextListing = false;
let delayNextDisconnect = false;
let failNextDisconnect = false;
let finishDisconnect: (() => void) | undefined;
function checkFilePermission() {
  if (!denyNextFileChange) return;
  denyNextFileChange = false;
  log("file operation denied");
  throw new Error("Permission denied: fixture folder is read-only.");
}
const documents = new Map<string, TextDocument>();
const folders = new Map<string, Directory>();
async function folder(id: number, path = "/home/demo") {
  if (!sessions.has(id)) throw new Error("Fixture session closed");
  const key = fileKey(id, path);
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
      "files.move",
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
    checkFilePermission();
    const directory = await folder(id, parent);
    if (directory.entries.some((entry) => entry.name === name))
      throw new Error("An item already exists. Choose a different name.");
    const path = `${parent.replace(/\/$/, "")}/${name}`;
    const doc = { path, name, parent, text, revision: "1", writable: true };
    directory.entries.push({
      name,
      path,
      kind: "file",
      size: new TextEncoder().encode(text).length,
      modified: 1,
      revision: "1",
    });
    documents.set(fileKey(id, path), doc);
    log(`created ${path}`);
    return { ...doc };
  },
  makeDirectory: async (id, parent, name) => {
    checkFilePermission();
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
    folders.set(fileKey(id, path), {
      ...directory,
      path,
      name,
      parent,
      entries: [],
    });
    log(`folder created ${path}`);
    return path;
  },
  renameEntry: async (id, path, name, revision, tracked) => {
    checkFilePermission();
    const { parent, entry } = await findEntry(id, path, revision);
    if (parent.entries.some((entry) => entry.name === name))
      throw new Error("An item already exists. Choose a different name.");
    const destination = `${parent.path.replace(/\/$/, "")}/${name}`;
    entry.name = name;
    entry.path = destination;
    entry.revision = String(Number(entry.revision) + 1);
    const doc = documents.get(fileKey(id, path));
    if (doc) {
      documents.delete(fileKey(id, path));
      documents.set(fileKey(id, destination), {
        ...doc,
        name,
        path: destination,
      });
    }
    log(`renamed ${path} -> ${destination}`);
    if (entry.kind === "directory") {
      for (const [key, value] of [...folders]) {
        if (key !== fileKey(id, value.path)) continue;
        const mapped = posixRelocation(path, destination, [value.path], true)
          .locations[0];
        if (!mapped) continue;
        folders.delete(key);
        folders.set(fileKey(id, mapped.location.path), {
          ...value,
          ...mapped.location,
          entries: value.entries.map((item) => ({
            ...item,
            path: destination + item.path.slice(path.length),
          })),
        });
      }
      for (const [key, value] of [...documents]) {
        if (key !== fileKey(id, value.path)) continue;
        const mapped = posixRelocation(path, destination, [value.path], true)
          .locations[0];
        if (!mapped) continue;
        documents.delete(key);
        documents.set(fileKey(id, mapped.location.path), {
          ...value,
          ...mapped.location,
        });
      }
    }
    return posixRelocation(
      path,
      destination,
      tracked,
      entry.kind === "directory",
    );
  },
  moveEntry: async (id, path, destinationParent, revision, tracked) => {
    checkFilePermission();
    const { parent, entry } = await findEntry(id, path, revision);
    if (
      entry.kind === "directory" &&
      (destinationParent === path || destinationParent.startsWith(`${path}/`))
    )
      throw new Error("A folder cannot be moved into itself or a child.");
    const target = await folder(id, destinationParent);
    if (target.entries.some((item) => item.name === entry.name))
      throw new Error(
        "An item already exists at this destination. Nothing was replaced.",
      );
    const destination = `${target.path.replace(/\/$/, "")}/${entry.name}`;
    parent.entries = parent.entries.filter((item) => item.path !== path);
    target.entries.push({ ...entry, path: destination });
    // This fixture adapter owns its POSIX path mapping, including loaded children.
    for (const [key, value] of [...folders]) {
      if (
        key === fileKey(id, value.path) &&
        (value.path === path || value.path.startsWith(`${path}/`))
      ) {
        const movedPath = destination + value.path.slice(path.length);
        folders.delete(key);
        folders.set(fileKey(id, movedPath), {
          ...value,
          path: movedPath,
          parent:
            value.path === path
              ? target.path
              : destination + value.parent!.slice(path.length),
          entries: value.entries.map((item) => ({
            ...item,
            path: destination + item.path.slice(path.length),
          })),
        });
      }
    }
    for (const [key, value] of [...documents]) {
      if (
        key === fileKey(id, value.path) &&
        (value.path === path || value.path.startsWith(`${path}/`))
      ) {
        const movedPath = destination + value.path.slice(path.length);
        documents.delete(key);
        documents.set(fileKey(id, movedPath), {
          ...value,
          path: movedPath,
          parent:
            value.path === path
              ? target.path
              : destination + value.parent!.slice(path.length),
        });
      }
    }
    log(`moved ${path} -> ${destination}`);
    return posixRelocation(
      path,
      destination,
      tracked,
      entry.kind === "directory",
    );
  },
  removeEntry: async (id, path, revision) => {
    checkFilePermission();
    const { parent, entry } = await findEntry(id, path, revision);
    if (entry.kind === "directory" && (await folder(id, path)).entries.length)
      throw new Error("Only empty folders can be deleted.");
    parent.entries = parent.entries.filter((entry) => entry.path !== path);
    documents.delete(fileKey(id, path));
    log(`deleted ${path}`);
  },
  readText: async (id, path) => {
    if (!sessions.has(id)) throw new Error("Fixture session closed");
    const key = fileKey(id, path);
    if (!documents.has(key))
      documents.set(key, {
        path,
        name: path.split("/").pop()!,
        parent: path.slice(0, path.lastIndexOf("/")) || "/",
        text: "# Fixture document\r\nHello from the remote file.\r\n",
        revision: "0",
        writable: true,
      });
    return { ...documents.get(key)! };
  },
  saveText: async (id, path, text, revision) => {
    checkFilePermission();
    if (!sessions.has(id)) throw new Error("Fixture session closed");
    const key = fileKey(id, path),
      current = documents.get(key)!;
    if (!current || current.revision !== revision)
      throw new Error(
        "CONFLICT: The remote file changed. Your draft is intact.",
      );
    const saved = { ...current, text, revision: String(Number(revision) + 1) };
    documents.set(key, saved);
    log(`saved ${path}`);
    return saved;
  },
  profiles: async () =>
    ["beta", "failure", "slow", "late"].map((name) => ({
      name: `Fixture ${name}`,
      host: `${name}.example`,
      username: "fixture",
      port: 22,
      keyPath: "/fixture/key",
    })),
  connect: async (options, signal) => {
    if (options.host === "slow.example" || options.host === "late.example") {
      log(`connecting ${options.host}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2500);
        if (options.host === "slow.example")
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("Connection canceled"));
            },
            { once: true },
          );
      });
    }
    if (options.host === "failure.example")
      throw new Error("Fixture connection refused");
    const session: Session = {
      ...first,
      id: ++next,
      info: {
        ...first.info,
        hostname: `fixture-${options.host.split(".")[0]}`,
        capabilities: nextWithoutFiles ? ["terminal"] : first.info.capabilities,
      },
    };
    nextWithoutFiles = false;
    sessionHosts.set(session.id, options.host);
    sessions.set(session.id, session);
    log(`connected ${session.id}`);
    return session;
  },
  disconnect: async (id) => {
    sessions.delete(id);
    if (delayNextDisconnect) {
      delayNextDisconnect = false;
      log(`disconnecting ${id}`);
      await new Promise<void>((resolve) => {
        finishDisconnect = resolve;
      });
      finishDisconnect = undefined;
    }
    if (failNextDisconnect) {
      failNextDisconnect = false;
      log(`cleanup failed ${id}`);
      throw new Error("Fixture transport cleanup unconfirmed");
    }
    log(`disconnected ${id}`);
  },
  alive: async (id) => sessions.has(id),
  list: async (id, path) => {
    if (failNextListing) {
      failNextListing = false;
      throw new Error("Fixture directory read failed");
    }
    const result = await folder(id, path);
    const snapshot = {
      ...result,
      entries: result.entries.map((entry: FileEntry) => ({ ...entry })),
    };
    if (delayNextListing) {
      delayNextListing = false;
      log(`delayed listing ${snapshot.path}`);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      log(`released old listing ${snapshot.path}`);
    }
    return snapshot;
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
      <App
        services={backend}
        initialSession={first}
        initialConnection={{
          name: "fixture-alpha",
          host: "alpha.example",
          port: 22,
          username: "fixture",
          keyPath: "/fixture/key",
        }}
        isNative
      />
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
            delayNextDisconnect = true;
          }}
        >
          Delay next disconnect
        </button>
        <button onClick={() => finishDisconnect?.()}>Finish disconnect</button>
        <button
          onClick={() => {
            failNextDisconnect = true;
          }}
        >
          Fail next disconnect
        </button>
        <button
          onClick={() => {
            delayNextListing = true;
          }}
        >
          Delay next directory read
        </button>
        <button
          onClick={() => {
            failNextListing = true;
          }}
        >
          Fail next directory read
        </button>
        <button
          onClick={() => {
            denyNextFileChange = true;
          }}
        >
          Deny next file change
        </button>
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
        <button
          onClick={() => {
            for (const id of sessions.keys())
              if (sessionHosts.get(id) === "alpha.example") sessions.delete(id);
          }}
        >
          Simulate connection loss
        </button>
        <button
          onClick={() => {
            nextWithoutFiles = true;
          }}
        >
          Next connection without files
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
