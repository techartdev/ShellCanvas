// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Trash2 } from "lucide-react";
import type { FileEntry, SessionServices } from "../sdk";
import { deleteFiles, type DeleteResult } from "../file-delete";
import "./FileActionDialog.css";
export function DeleteFilesDialog({
  entries,
  services,
  available,
  close,
  setBusy,
}: {
  entries: readonly Readonly<FileEntry>[];
  services: SessionServices;
  available: boolean;
  close(): void;
  setBusy(value: boolean): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const live = useRef(true);
  const allowed = useRef(available);
  allowed.current = available;
  const stop = useRef(false);
  const started = useRef(false);
  const [working, setWorking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [finished, setFinished] = useState(false);
  const [results, setResults] = useState<DeleteResult[]>([]);
  const [error, setError] = useState("");
  if (started.current && !available) stop.current = true;
  useEffect(() => {
    live.current = true;
    stop.current = false;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      live.current = false;
      stop.current = true;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  async function submit() {
    if (started.current || !allowed.current) return;
    started.current = true;
    setWorking(true);
    setBusy(true);
    try {
      await deleteFiles(
        services,
        entries,
        () => live.current && allowed.current && !stop.current,
        (result) => {
          if (live.current) setResults((old) => [...old, result]);
        },
      );
    } catch (error) {
      if (live.current) setError(String(error));
    } finally {
      if (live.current) {
        setWorking(false);
        setFinished(true);
        setBusy(false);
      }
    }
  }
  const deleted = results.filter(
    (result) => result.status === "deleted",
  ).length;
  const failed = results.find((result) => result.status === "failed");
  return createPortal(
    <dialog
      className="file-action-dialog batch-delete-dialog"
      ref={dialog}
      aria-label="Delete selected items"
      onCancel={(event) => {
        event.preventDefault();
        if (!working) close();
      }}
    >
      <div className="file-action-emblem destructive">
        <Trash2 size={23} />
      </div>
      <p className="eyebrow">REMOTE FILES</p>
      <h2>
        {finished ? "Deletion results" : `Delete ${entries.length} items?`}
      </h2>
      <p className="file-action-description">
        Files, links and empty folders are deleted permanently. Link targets are
        kept. There is no trash or undo. Processing stops at the first failure.
      </p>
      <ul className="batch-delete-list" aria-label="Items to delete">
        {entries.map((entry, index) => {
          const result = results[index];
          return (
            <li key={entry.path}>
              <span>
                <strong>{entry.name}</strong>
                <small>{entry.path}</small>
              </span>
              <em>
                {result?.status === "deleted"
                  ? "Deleted"
                  : result?.status === "failed"
                    ? "Not confirmed"
                    : working && index === results.length
                      ? "Deleting…"
                      : finished
                        ? "Not attempted"
                        : entry.kind === "directory"
                          ? "Empty folder only"
                          : entry.kind}
              </em>
            </li>
          );
        })}
      </ul>
      {(error || failed) && (
        <div className="inline-error" role="alert">
          {error ||
            `${failed!.entry.name}: ${failed!.error} Verify this item's remote state before retrying.`}
        </div>
      )}
      {!available && (
        <p className="file-action-description">
          The original file connection is unavailable. No further items will be
          started.
        </p>
      )}
      <p role="status" className="file-action-description">
        {finished
          ? `${deleted} deleted${failed ? " · 1 not confirmed" : ""} · ${entries.length - results.length} not attempted`
          : working
            ? `${deleted} of ${entries.length} deleted${stopping ? " · Stopping after the current item…" : ""}`
            : "Review the selected names and locations before deleting."}
      </p>
      <div className="file-action-buttons">
        {working ? (
          <button
            disabled={stopping}
            onClick={() => {
              stop.current = true;
              setStopping(true);
            }}
          >
            Stop after current item
          </button>
        ) : (
          <button autoFocus onClick={close}>
            {finished ? "Done" : "Cancel"}
          </button>
        )}
        {!finished && (
          <button
            className="danger-button"
            disabled={working || !available}
            onClick={() => void submit()}
          >
            {working ? (
              <>
                <LoaderCircle size={14} className="spin" /> Deleting…
              </>
            ) : (
              "Delete permanently"
            )}
          </button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
