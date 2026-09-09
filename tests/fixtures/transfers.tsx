// SPDX-License-Identifier: MPL-2.0
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { previewServices, previewSession } from "../../src/preview";
import type { FileEntry, HostServices, TransferTicket } from "../../src/sdk";
import "../../src/styles.css";
let next = 0,
  failNext = false;
let record: (text: string) => void = () => {};
const batch = new URLSearchParams(location.search).get("batch") === "65";
const pending = new Map<
  number,
  { ticket: TransferTicket; parent: string; canceled: boolean; fail: boolean }
>();
const uploaded = new Map<string, FileEntry[]>();
function prepare(
  name: string,
  size: number,
  direction: TransferTicket["direction"],
  parent: string,
) {
  const ticket = { id: ++next, name, size, direction };
  pending.set(ticket.id, { ticket, parent, canceled: false, fail: failNext });
  failNext = false;
  record(`selected ${direction} ${ticket.id}: ${name}`);
  return ticket;
}
const backend: HostServices = {
  ...previewServices,
  list: async (id, path) => {
    const dir = await previewServices.list(id, path);
    return {
      ...dir,
      entries: batch
        ? Array.from({ length: 65 }, (_, i) => ({
            name: `item-${String(i).padStart(2, "0")}.bin`,
            path: `${dir.path}/item-${i}.bin`,
            kind: "file" as const,
            size: 1024,
            modified: null,
            revision: "1",
          }))
        : [
            ...dir.entries.map((e) => ({ ...e, revision: "1" })),
            ...(uploaded.get(dir.path) ?? []),
          ],
    };
  },
  chooseUploads: async (_, parent) =>
    batch
      ? [prepare("65 selected items", 65 * 1024, "upload", parent)]
      : [
          prepare("small.bin", 131072, "upload", parent),
          prepare("large.bin", 16 * 1024 * 1024, "upload", parent),
        ],
  chooseDownload: async (_, path) =>
    prepare(path.split("/").pop()!, 512 * 1024, "download", ""),
  chooseDownloads: async (_, entries) => {
    record(`download selection: ${entries.length} roots`);
    return [
      prepare(
        `${entries.length} selected items`,
        entries.length * 1024,
        "download",
        "",
      ),
    ];
  },
  cancelTransfer: async (_, id) => {
    const job = pending.get(id);
    if (job) job.canceled = true;
    record(`cancel ${id}`);
  },
  runTransfer: async (_, id, onProgress) => {
    const job = pending.get(id)!;
    record(`start ${id}`);
    let bytes = 0;
    try {
      if (
        job.ticket.direction === "upload" &&
        uploaded.get(job.parent)?.some((e) => e.name === job.ticket.name)
      )
        return {
          status: "failed",
          bytes,
          total: job.ticket.size,
          message: "That destination already exists. Nothing was replaced.",
        };
      while (bytes < job.ticket.size) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (job.canceled)
          return {
            status: "canceled",
            bytes,
            total: job.ticket.size,
            message: "Transfer canceled",
          };
        bytes = Math.min(
          job.ticket.size,
          bytes + (job.ticket.name === "large.bin" ? 512 * 1024 : 32768),
        );
        onProgress({ bytes, total: job.ticket.size, phase: "running" });
        if (job.fail)
          return {
            status: "failed",
            bytes,
            total: job.ticket.size,
            message:
              "Fixture connection lost. Temporary cleanup could not be confirmed: .shellcanvas-upload-fixture",
          };
      }
      onProgress({ bytes, total: job.ticket.size, phase: "finishing" });
      const path = `${job.parent}/${job.ticket.name}`;
      if (job.ticket.direction === "upload")
        uploaded.set(job.parent, [
          ...(uploaded.get(job.parent) ?? []),
          {
            path,
            name: job.ticket.name,
            kind: "file",
            size: bytes,
            modified: null,
            revision: "1",
          },
        ]);
      record(`complete ${id}`);
      return { status: "completed", bytes, total: job.ticket.size, path };
    } finally {
      pending.delete(id);
    }
  },
};
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  record = (text) => setEvents((old) => [...old.slice(-29), text]);
  return (
    <>
      <App
        services={backend}
        initialSession={{
          ...previewSession,
          info: {
            ...previewSession.info,
            capabilities: [
              "files.read",
              "files.upload",
              "files.download",
              "terminal",
            ],
          },
        }}
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
        <summary>Transfer fixture</summary>
        <button
          onClick={() => {
            failNext = true;
          }}
        >
          Fail next transfer
        </button>
        <pre aria-label="Transfer events">{events.join("\n")}</pre>
      </details>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
