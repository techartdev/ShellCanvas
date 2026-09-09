// SPDX-License-Identifier: MPL-2.0
import { showModal } from "../dialog-compat";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  ChevronRight,
  Folder,
  FolderInput,
  LoaderCircle,
} from "lucide-react";
import type {
  Directory,
  FileEntry,
  SessionServices,
  TransferTicket,
} from "../sdk";
import "./FileActionDialog.css";
import { scanDirectory } from "../directory-scan";
import { useVirtualRows } from "./useVirtualRows";

export function MoveFileDialog({
  entry,
  initialParent,
  services,
  disabled,
  close,
  setBusy,
  copy = false,
  prepared,
}: {
  entry: FileEntry;
  initialParent: string;
  services: SessionServices;
  disabled: boolean;
  close(): void;
  setBusy(value: boolean): void;
  copy?: boolean;
  prepared?(ticket: TransferTicket): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const addressId = useId();
  const address = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const directoryScan = useRef<AbortController | null>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [path, setPath] = useState(initialParent);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function navigate(location: string) {
    if (disabled || working) return;
    directoryScan.current?.abort();
    const scan = new AbortController();
    directoryScan.current = scan;
    const current = ++request.current;
    setLoading(true);
    setError("");
    setDirectory(null);
    setPath(location);
    let first = true;
    try {
      await scanDirectory(services, location, scan.signal, (result) => {
        if (current !== request.current || scan.signal.aborted) return;
        setDirectory(result);
        if (first) setPath(result.path);
        first = false;
      });
    } catch (error) {
      if (current === request.current && !scan.signal.aborted)
        setError(String(error));
    } finally {
      if (current === request.current) setLoading(false);
      if (directoryScan.current === scan) directoryScan.current = null;
    }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    showModal(dialog.current);
    address.current?.focus();
    void navigate(initialParent);
    return () => {
      directoryScan.current?.abort();
      ++request.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (disabled) {
      directoryScan.current?.abort();
      ++request.current;
      setLoading(false);
    }
  }, [disabled]);
  const sameFolder = directory?.path === initialParent;
  const folders =
    directory?.entries.filter(
      (item) => item.kind === "directory" && item.path !== entry.path,
    ) ?? [];
  const rows = useVirtualRows(folders.length);
  const canMove =
    !disabled &&
    !working &&
    !loading &&
    !!entry.revision &&
    !!directory &&
    path === directory.path &&
    !sameFolder;
  async function move() {
    if (!canMove || !directory || !entry.revision) return;
    setWorking(true);
    setBusy(true);
    setError("");
    try {
      if (copy) {
        const ticket = await services.prepareCopy(
          entry.path,
          entry.revision,
          directory.path,
        );
        if (prepared) prepared(ticket);
        else await services.cancelTransfer(ticket.id);
      } else
        await services.moveEntry(entry.path, directory.path, entry.revision);
      close();
    } catch (error) {
      setError(String(error));
    } finally {
      setWorking(false);
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="file-action-dialog move-file-dialog"
      aria-label={copy ? "Copy to folder" : "Move to folder"}
      onCancel={(event) => {
        event.preventDefault();
        if (!working) close();
      }}
    >
      <div className="file-action-emblem">
        <FolderInput size={23} />
      </div>
      <p className="eyebrow">REMOTE FILES</p>
      <h2>{copy ? "Copy to folder" : "Move to folder"}</h2>
      <p className="file-action-description">
        Choose a destination on this host. The name stays the same; existing
        items are never replaced.
        {copy &&
          " The source stays in place. Follow progress or cancel from the transfer list."}
      </p>
      <div className="file-action-target">
        <strong>{entry.name}</strong>
        <span>{entry.path}</span>
      </div>
      <label htmlFor={addressId}>Destination folder</label>
      <div className="move-folder-address">
        <button
          type="button"
          aria-label="Parent folder"
          disabled={disabled || working || !directory?.parent}
          onClick={() => directory?.parent && void navigate(directory.parent)}
        >
          <ArrowUp size={16} />
        </button>
        <input
          id={addressId}
          ref={address}
          value={path}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled || working}
          onChange={(event) => {
            ++request.current; // A late listing must not replace a newly typed address.
            setLoading(false);
            setPath(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (path.trim()) void navigate(path);
            }
          }}
        />
        <button
          type="button"
          disabled={disabled || working || !path.trim()}
          onClick={() => void navigate(path)}
        >
          Go
        </button>
      </div>
      {directory && (
        <div className="move-folder-places">
          {[
            ...(directory.home ? [directory.home] : []),
            ...directory.roots,
          ].map((place, index) => (
            <button
              type="button"
              key={`${index}:${place.path}`}
              disabled={disabled || working}
              onClick={() => void navigate(place.path)}
            >
              {place.name}
            </button>
          ))}
        </div>
      )}
      <div
        className="move-folder-list"
        ref={rows.attach}
        aria-label="Destination folders"
        aria-busy={loading}
      >
        {loading && !directory?.entries.length ? (
          <p>
            <LoaderCircle size={16} className="spin" /> Loading folders…
          </p>
        ) : (
          directory && (
            <>
              <div aria-hidden="true" style={{ height: rows.before }} />
              {folders.slice(rows.start, rows.end).map((item, rowOffset) => (
                <button
                  type="button"
                  key={item.path}
                  data-virtual-index={rows.start + rowOffset}
                  title={item.name}
                  onKeyDown={(event) => {
                    const index = rows.start + rowOffset;
                    const next =
                      event.key === "ArrowDown"
                        ? Math.min(folders.length - 1, index + 1)
                        : event.key === "ArrowUp"
                          ? Math.max(0, index - 1)
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? folders.length - 1
                              : -1;
                    if (next >= 0) {
                      event.preventDefault();
                      rows.focus(next);
                    }
                  }}
                  disabled={disabled || working}
                  onClick={() => void navigate(item.path)}
                >
                  <Folder size={17} />
                  <span>{item.name}</span>
                  <ChevronRight size={14} />
                </button>
              ))}
              <div aria-hidden="true" style={{ height: rows.after }} />
              {!loading &&
                !directory.entries.some(
                  (item) =>
                    item.kind === "directory" && item.path !== entry.path,
                ) && <p>No subfolders here</p>}
            </>
          )
        )}
      </div>
      <p className="file-action-description move-folder-review">
        {disabled ? (
          "This host session is no longer available. Close this dialog and reconnect."
        ) : path !== directory?.path ? (
          "Open a folder to review the destination."
        ) : sameFolder ? (
          "This item is already in this folder."
        ) : (
          <>
            {copy ? "Copy" : "Move"} <strong>{entry.name}</strong> into{" "}
            <strong>{directory?.path}</strong>
          </>
        )}
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="file-action-buttons">
        {loading && (
          <span role="status">
            {directory?.entries.length ?? 0} items · discovering…
          </span>
        )}
        <button type="button" disabled={working} onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="file-action-submit"
          disabled={!canMove}
          onClick={() => void move()}
        >
          {working ? (
            <>
              <LoaderCircle size={14} className="spin" />{" "}
              {copy ? "Preparing…" : "Moving…"}
            </>
          ) : copy ? (
            "Copy here"
          ) : (
            "Move here"
          )}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
