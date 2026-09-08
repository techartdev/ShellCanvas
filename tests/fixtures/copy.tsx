// SPDX-License-Identifier: MPL-2.0
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { previewServices, previewSession } from "../../src/preview";
import type {
  HostServices,
  FileEntry,
  Directory,
  TransferTicket,
} from "../../src/sdk";
import "../../src/styles.css";

const source = {
  name: "binary.bin",
  path: "item@93?kind=binary",
  kind: "file" as const,
  revision: "v1",
  size: 131072,
  modified: null,
};
let copied: FileEntry | undefined;
let next = 0;
const jobs = new Map<number, string>();
const canceled = new Set<number>();
const session = {
  ...previewSession,
  info: {
    ...previewSession.info,
    hostname: "copy-fixture",
    capabilities: ["files.read", "files.copy"] as const,
  },
};
const directory = (path = "source@1"): Directory => {
  if (!["source@1", "destination@2"].includes(path))
    throw new Error("Unknown fixture folder");
  return {
    path,
    name: path === "source@1" ? "Source" : "Destination",
    parent: null,
    home: { path: "source@1", name: "Source" },
    roots: [{ path: "destination@2", name: "Destination" }],
    entries: path === "source@1" ? [source] : copied ? [copied] : [],
  };
};
const backend: HostServices = {
  ...previewServices,
  profiles: async () => [],
  list: async (_, path) => directory(path),
  prepareCopy: async (_, path, revision, parent) => {
    if (
      path !== source.path ||
      revision !== source.revision ||
      parent !== "destination@2"
    )
      throw new Error("Wrong opaque source, revision or destination");
    const ticket: TransferTicket = {
      id: ++next,
      name: source.name,
      size: source.size,
      direction: "copy",
    };
    jobs.set(ticket.id, parent);
    return ticket;
  },
  cancelTransfer: async (_, id) => {
    canceled.add(id);
  },
  runTransfer: async (_, id, onProgress) => {
    if (!jobs.has(id)) throw new Error("Unknown copy ticket");
    if (copied)
      return {
        status: "failed",
        bytes: 0,
        total: source.size,
        message: "The destination already exists. Nothing was replaced.",
      };
    for (let bytes = 0; bytes < source.size; bytes += 32768) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (canceled.has(id))
        return { status: "canceled", bytes, total: source.size };
      onProgress({
        bytes: bytes + 32768,
        total: source.size,
        phase: "running",
      });
    }
    copied = { ...source, path: "copied@1", revision: "copy-v1" };
    jobs.delete(id);
    return {
      status: "completed",
      bytes: source.size,
      total: source.size,
      path: copied.path,
    };
  },
};
createRoot(document.getElementById("root")!).render(
  <App
    services={backend}
    isNative={true}
    initialSession={{
      ...session,
      info: { ...session.info, capabilities: [...session.info.capabilities] },
    }}
  />,
);
