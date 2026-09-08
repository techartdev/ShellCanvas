// SPDX-License-Identifier: MPL-2.0
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Files } from "../../src/apps/Files";
import { clipboard } from "../../src/clipboard";
import { bindSession } from "../../src/session-services";
import { previewServices, previewSession } from "../../src/preview";
import type { FileEntry, Session, TransferTicket } from "../../src/sdk";
import "../../src/styles.css";
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const slowClipboard = new URLSearchParams(location.search).has("slow");
  const clipboardReject = useRef<((reason: Error) => void) | null>(null);
  const release = useRef<(fail: boolean) => void>(() => {});
  const entries = useRef<FileEntry[]>(
    ["alpha.txt", "beta.txt"].map((name, i) => ({
      name,
      path: `object@${i}`,
      size: 8,
      modified: null,
      kind: "file",
      revision: `revision-${i}`,
    })),
  );
  const destination = useRef<FileEntry[]>([]);
  const jobs = useRef(
    new Map<
      number,
      {
        path: string;
        parent?: string;
        direction: "copy" | "download" | "upload";
        name: string;
      }
    >(),
  );
  const serial = useRef(0);
  const systemSequence = useRef(0);
  const localCopied = useRef(false);
  const record = (event: string) => setEvents((old) => [...old, event]);
  clipboard.writeText = async (text) => {
    ++systemSequence.current;
    localCopied.current = false;
    record(`Text clipboard: ${text}`);
  };
  const [session] = useState<Session>(() => ({
    ...previewSession,
    info: {
      ...previewSession.info,
      capabilities: [
        "files.read",
        "files.move",
        "files.copy",
        "files.download",
        "files.upload",
      ],
    },
  }));
  const [services, setServices] = useState(
    () =>
      bindSession(
        {
          ...previewServices,
          systemFileClipboard: true,
          systemClipboardSequence: async () => systemSequence.current,
          cutToSystem: async () => ++systemSequence.current,
          pasteSystemFiles: async (_, parent) => {
            if (!localCopied.current) return null;
            record(`Pasted local files into: ${parent}`);
            return ["local-a.txt", "local-b.txt"].map((name) => {
              const id = ++serial.current;
              jobs.current.set(id, {
                path: name,
                parent,
                direction: "upload",
                name,
              });
              return { id, name, size: 8, direction: "upload" as const };
            });
          },
          cancelClipboardPreparation: async (_, id) => {
            record(`Canceled clipboard scan: ${id}`);
            clipboardReject.current?.(new Error("Transfer canceled"));
            clipboardReject.current = null;
          },
          copyToSystem: async (_, files, preparation) => {
            localCopied.current = false;
            record(
              `System clipboard descriptors: ${files.map((file) => file.path).join(", ")} · no file reads`,
            );
            if (slowClipboard) {
              preparation?.onProgress?.({
                bytes: 0,
                total: 150000000,
                items: 50000,
                phase: "preparing",
              });
              return new Promise<number>((_, reject) => {
                clipboardReject.current = reject;
              });
            }
            return ++systemSequence.current;
          },
          list: async (_, path) => ({
            path: path ?? "root@source",
            name: path === "root@destination" ? "Destination" : "Source",
            parent: null,
            home: null,
            roots: [
              { name: "Source", path: "root@source" },
              { name: "Destination", path: "root@destination" },
            ],
            entries: [
              ...(path === "root@destination"
                ? destination.current
                : entries.current),
            ],
          }),
          prepareCopy: async (_, path, revision, parent) => {
            const source = entries.current.find(
              (entry) => entry.path === path && entry.revision === revision,
            )!;
            const id = ++serial.current;
            jobs.current.set(id, {
              path,
              parent,
              direction: "copy",
              name: source.name,
            });
            record(`Prepared copy: ${path} → ${parent}`);
            return { id, name: source.name, size: 8, direction: "copy" };
          },
          chooseDownloads: async (_, files) => {
            record(`One folder picker: ${files.length} files`);
            return files.map((file): TransferTicket => {
              const entry = entries.current.find(
                (entry) => entry.path === file.path,
              )!;
              const id = ++serial.current;
              jobs.current.set(id, {
                path: file.path,
                direction: "download",
                name: entry.name,
              });
              return { id, name: entry.name, size: 8, direction: "download" };
            });
          },
          runTransfer: async (_, id, progress) => {
            const job = jobs.current.get(id)!;
            record(`Started ${job.direction}: ${job.name}`);
            setPending(true);
            progress({ bytes: 4, total: 8, phase: "running" });
            await new Promise<void>((resolve, reject) => {
              release.current = (fail) => {
                setPending(false);
                fail ? reject(new Error("Fixture transfer failed")) : resolve();
              };
            });
            if (!jobs.current.has(id))
              return { status: "canceled", bytes: 4, total: 8 };
            if (job.direction === "copy") {
              if (destination.current.some((entry) => entry.name === job.name))
                throw new Error("Destination already exists");
              destination.current.push({
                ...entries.current.find((entry) => entry.path === job.path)!,
                path: `copied@${id}`,
              });
            }
            jobs.current.delete(id);
            record(`Completed ${job.direction}: ${job.name}`);
            return {
              status: "completed",
              bytes: 8,
              total: 8,
              path: job.parent ?? "local fixture folder",
            };
          },
          cancelTransfer: async (_, id) => {
            jobs.current.delete(id);
            release.current(false);
            record(`Canceled ticket: ${id}`);
          },
        },
        session,
      ).services,
  );
  return (
    <>
      <div style={{ display: "flex", padding: 12, gap: 12 }}>
        {slowClipboard && (
          <button onClick={() => setServices((old) => ({ ...old }))}>
            Replace service binding
          </button>
        )}
        <button disabled={!pending} onClick={() => release.current(false)}>
          Complete transfer
        </button>
        <button disabled={!pending} onClick={() => release.current(true)}>
          Fail transfer
        </button>
        <button
          onClick={() => {
            ++systemSequence.current;
            localCopied.current = true;
            record("Explorer copied two local files");
          }}
        >
          Simulate Explorer Copy
        </button>
        <button
          onClick={() => {
            ++systemSequence.current;
            localCopied.current = false;
            record("System clipboard replaced by text");
          }}
        >
          Simulate text Copy
        </button>
      </div>
      <div style={{ display: "flex", gap: 12, padding: 12, height: 580 }}>
        {["Source files", "Destination files"].map((name, i) => (
          <section
            key={name}
            aria-label={name}
            style={{
              width: "50%",
              display: "flex",
              border: "1px solid #668899",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <Files
              session={session}
              services={services}
              preview={false}
              launch={{ path: i ? "root@destination" : "root@source" }}
              connect={() => {}}
              reportError={record}
            />
          </section>
        ))}
      </div>
      <pre style={{ padding: 12, fontSize: 11 }}>{events.join("\n")}</pre>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
