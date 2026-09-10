// SPDX-License-Identifier: MPL-2.0
import { showModal } from "../dialog-compat";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowUp,
  File,
  Folder,
  Info,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import type { Directory, FileEntry } from "../sdk";
import { scanDirectory } from "../directory-scan";
import { useVirtualRows } from "./useVirtualRows";
import {
  desktopDialogs,
  type DialogQueue,
  type DialogRequest,
} from "../system-dialogs";
import "./SystemDialogHost.css";

export function SystemDialogHost({
  queue = desktopDialogs,
}: {
  queue?: DialogQueue;
}) {
  const request = useSyncExternalStore(queue.subscribe, queue.snapshot)[0];
  return request
    ? createPortal(<Dialog key={request.id} request={request} />, document.body)
    : null;
}
function Dialog({ request }: { request: DialogRequest }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = () =>
    request.resolve(
      request.kind === "message" ? (request.options.cancelId ?? null) : null,
    );
  useEffect(() => {
    const previous = request.returnFocus;
    request.owner.focus();
    showModal(dialog.current);
    dialog.current
      ?.querySelector<HTMLElement>("[data-dialog-focus='true']")
      ?.focus();
    return () => {
      // Callers often disable the initiating button while awaiting the dialog.
      // Restore after their promise handler has re-enabled it, unless a new
      // modal has already taken focus (for example replacement review).
      requestAnimationFrame(() => {
        if (previous?.isConnected && !document.querySelector("dialog[open]")) {
          const target = previous.matches(":disabled")
            ? previous
                .closest(".app-window")
                ?.querySelector<HTMLElement>("[data-window-titlebar]")
            : previous;
          target?.focus({ preventScroll: true });
        }
      });
    };
  }, [request]);
  const title =
    request.options.title ?? (request.kind === "open" ? "Open" : "Save as");
  return (
    <dialog
      ref={dialog}
      className={`system-dialog ${request.kind === "message" ? "system-message" : "system-picker"}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <header className="system-dialog-header">
        <div>
          <p className="eyebrow">{request.owner.title}</p>
          <h2>{title}</h2>
        </div>
        <button type="button" aria-label="Close dialog" onClick={cancel}>
          <X size={17} />
        </button>
      </header>
      {request.kind === "message" ? (
        <>
          <div
            className={`system-message-icon ${request.options.kind ?? "info"}`}
          >
            {request.options.kind === "warning" ||
            request.options.kind === "error" ? (
              <ShieldAlert size={26} />
            ) : (
              <Info size={26} />
            )}
          </div>
          <p className="system-message-text">{request.options.message}</p>
          <footer
            className={`system-dialog-actions${request.options.buttons!.length > 2 ? " system-dialog-choices" : ""}`}
          >
            {request.options.buttons!.map((button, index) => (
              <button
                key={button.id}
                className={
                  button.destructive
                    ? "danger-button"
                    : button.id === request.options.defaultId
                      ? "system-primary"
                      : ""
                }
                autoFocus={
                  request.options.defaultId
                    ? button.id === request.options.defaultId
                    : index === 0
                }
                data-dialog-focus={
                  request.options.defaultId
                    ? button.id === request.options.defaultId
                    : index === 0
                }
                onClick={() => request.resolve(button.id)}
              >
                {button.label}
              </button>
            ))}
          </footer>
        </>
      ) : (
        <FilePicker request={request} cancel={cancel} />
      )}
    </dialog>
  );
}
function FilePicker({
  request,
  cancel,
}: {
  request: Exclude<DialogRequest, { kind: "message" }>;
  cancel(): void;
}) {
  const [location, setLocation] = useState(request.options.directory);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [address, setAddress] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [name, setName] = useState(
    request.kind === "save" ? (request.options.name ?? "untitled.txt") : "",
  );
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const folderMode =
    request.kind === "open" && request.options.kind === "directory";
  useEffect(() => {
    const current = ++epoch.current;
    const scan = new AbortController();
    setLoading(true);
    setError("");
    setSelection([]);
    setDirectory(null);
    let first = true;
    void (async () => {
      request.owner.require("files.read");
      await scanDirectory(
        request.owner.services,
        location,
        scan.signal,
        (result) => {
          request.owner.require("files.read");
          if (epoch.current !== current || scan.signal.aborted) return;
          setDirectory(result);
          if (first) setAddress(result.path);
          first = false;
        },
      );
    })()
      .catch((error) => {
        if (epoch.current === current && !scan.signal.aborted)
          setError(String(error));
      })
      .finally(() => {
        if (epoch.current === current) setLoading(false);
      });
    return () => {
      scan.abort();
      ++epoch.current;
    };
  }, [request, location, refresh]);
  function navigate(path: string, back = false) {
    if (!back && directory) setHistory((old) => [...old, directory.path]);
    setLocation(path);
    setQuery("");
    setSelection([]);
    setRefresh((old) => old + 1);
  }
  function accepted(entry: FileEntry) {
    if (entry.kind === "directory") return true;
    if (entry.kind !== "file" || folderMode) return false;
    return (
      request.kind !== "open" ||
      !request.options.extensions?.length ||
      request.options.extensions.some((extension) =>
        entry.name.toLowerCase().endsWith(extension.toLowerCase()),
      )
    );
  }
  const entries =
    directory?.entries.filter(
      (entry) =>
        accepted(entry) &&
        entry.name.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const selected = entries.filter((entry) => selection.includes(entry.path));
  const rows = useVirtualRows(entries.length);
  function choose(entry: FileEntry) {
    if (request.kind === "save") {
      setSelection([entry.path]);
      if (entry.kind === "file") setName(entry.name);
      return;
    }
    setSelection((old) =>
      request.options.multiple
        ? old.includes(entry.path)
          ? old.filter((path) => path !== entry.path)
          : [...old, entry.path]
        : [entry.path],
    );
  }
  function submit() {
    if (loading || error || !directory) return;
    try {
      request.owner.require("files.read");
      if (request.kind === "save") {
        if (!name.trim() || /[\x00-\x1f\x7f]/.test(name))
          throw new Error("Enter a file name without control characters.");
        const matches = directory.entries.filter(
          (entry) => entry.name === name,
        );
        if (matches.length > 1)
          throw new Error("This filename is ambiguous. Choose another name.");
        const existing = matches[0];
        if (existing && existing.kind !== "file")
          throw new Error("A folder or link already uses this name.");
        request.resolve(
          Object.freeze({
            parent: directory.path,
            name,
            ...(existing ? { existing: Object.freeze({ ...existing }) } : {}),
          }),
        );
      } else if (folderMode) {
        const folders = selected.filter((entry) => entry.kind === "directory");
        request.resolve(
          Object.freeze(
            (folders.length
              ? folders
              : [
                  {
                    path: directory.path,
                    name: directory.name,
                    kind: "directory" as const,
                    size: 0,
                    modified: null,
                  },
                ]
            ).map((entry) => Object.freeze({ ...entry })),
          ),
        );
      } else if (
        selected.length &&
        selected.every((entry) => entry.kind === "file")
      ) {
        request.resolve(
          Object.freeze(selected.map((entry) => Object.freeze({ ...entry }))),
        );
      } else if (selected.length === 1 && selected[0].kind === "directory")
        navigate(selected[0].path);
    } catch (error) {
      setError(String(error));
    }
  }
  return (
    <>
      <div className="system-picker-toolbar">
        <button
          aria-label="Back"
          disabled={!history.length}
          onClick={() => {
            const path = history.at(-1)!;
            setHistory((old) => old.slice(0, -1));
            navigate(path, true);
          }}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          aria-label="Parent folder"
          disabled={!directory?.parent}
          onClick={() => navigate(directory!.parent!)}
        >
          <ArrowUp size={16} />
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim()) navigate(address);
          }}
        >
          <Folder size={15} />
          <input
            aria-label="Folder location"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            spellCheck={false}
          />
        </form>
        <button
          aria-label="Refresh folder"
          onClick={() => setRefresh((old) => old + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="system-picker-body">
        <nav aria-label="Places">
          <span className="eyebrow">PLACES</span>
          {directory?.home && (
            <button onClick={() => navigate(directory.home!.path)}>
              <Folder size={16} />
              {directory.home.name}
            </button>
          )}
          {directory?.roots.map((root) => (
            <button key={root.path} onClick={() => navigate(root.path)}>
              <Folder size={16} />
              {root.name}
            </button>
          ))}
        </nav>
        <section className="system-picker-files" aria-label="Files">
          <div className="system-picker-heading">
            <strong>{directory?.name ?? "Files"}</strong>
            <label>
              <Search size={14} />
              <input
                data-dialog-focus={request.kind === "open"}
                aria-label="Filter files"
                placeholder="Filter files"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelection([]);
                }}
              />
            </label>
          </div>
          <div
            className="system-picker-list"
            ref={rows.attach}
            aria-busy={loading}
          >
            {loading && !entries.length ? (
              <p className="system-picker-empty">
                <LoaderCircle className="spin" size={20} />
                Loading folder…
              </p>
            ) : (
              <>
                <div aria-hidden="true" style={{ height: rows.before }} />
                {entries.slice(rows.start, rows.end).map((entry, rowOffset) => (
                  <button
                    type="button"
                    key={entry.path}
                    data-virtual-index={rows.start + rowOffset}
                    title={entry.name}
                    onKeyDown={(event) => {
                      const index = rows.start + rowOffset;
                      const next =
                        event.key === "ArrowDown"
                          ? Math.min(entries.length - 1, index + 1)
                          : event.key === "ArrowUp"
                            ? Math.max(0, index - 1)
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? entries.length - 1
                                : -1;
                      if (next >= 0) {
                        event.preventDefault();
                        rows.focus(next);
                      }
                    }}
                    role="checkbox"
                    aria-checked={selection.includes(entry.path)}
                    className={selection.includes(entry.path) ? "selected" : ""}
                    onClick={() => choose(entry)}
                    onDoubleClick={() => {
                      if (entry.kind === "directory") navigate(entry.path);
                    }}
                  >
                    {entry.kind === "directory" ? (
                      <Folder size={19} className="system-folder-icon" />
                    ) : (
                      <File size={18} />
                    )}
                    <span>{entry.name}</span>
                    <small>
                      {entry.kind === "directory"
                        ? "Folder"
                        : `${entry.size.toLocaleString()} B`}
                    </small>
                  </button>
                ))}
                <div aria-hidden="true" style={{ height: rows.after }} />
              </>
            )}
            {!loading && !entries.length && !error && (
              <p className="system-picker-empty">
                {query ? "No matching files" : "This folder is empty"}
              </p>
            )}
          </div>
        </section>
      </div>
      {request.kind === "save" && (
        <label className="system-picker-name">
          File name
          <input
            data-dialog-focus="true"
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="system-dialog-error">
          {error}
        </p>
      )}
      <footer className="system-dialog-actions">
        <span>
          {loading
            ? `${directory?.entries.length ?? 0} items · discovering…`
            : request.kind === "save"
              ? "Choose a destination; saving happens next."
              : folderMode
                ? "Select a folder or use the current folder."
                : `${selected.length} selected`}
        </span>
        <button onClick={cancel}>Cancel</button>
        <button
          className="system-primary"
          disabled={
            loading ||
            !!error ||
            !directory ||
            (request.kind === "save"
              ? !name.trim()
              : !folderMode && !selected.length)
          }
          onClick={submit}
        >
          {request.kind === "save"
            ? "Choose destination"
            : folderMode
              ? "Select folder"
              : "Open"}
        </button>
      </footer>
    </>
  );
}
