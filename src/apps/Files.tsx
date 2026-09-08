// SPDX-License-Identifier: MPL-2.0
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Eye,
  FileCode2,
  FileText,
  Folder,
  Home,
  LoaderCircle,
  MoreHorizontal,
  FolderPlus,
  RefreshCw,
  Search,
  Server,
  X,
  Upload,
  Download,
} from "lucide-react";
import type { AppContext, Directory, FileEntry } from "../sdk";
import { ContextMenu, type MenuAction } from "../components/ContextMenu";
import { clipboard } from "../clipboard";
import { usePreferences } from "../preferences";
import { visibleFiles } from "../file-view";
import { FileActionDialog } from "../components/FileActionDialog";
import { MoveFileDialog } from "../components/MoveFileDialog";
import { watchFileChanges } from "../file-events";
import { TransferQueue, pendingTransfer } from "../transfer-queue";
import { TransferPanel } from "../components/TransferPanel";
function size(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`;
}
export function Files({
  session,
  services,
  preview,
  active = true,
  launch,
  openApp,
  connected = true,
  reportError,
  setDocumentState,
}: AppContext) {
  const { values: preferences, set: setPreference } = usePreferences();
  const [directory, setDirectory] = useState<Directory>({
    path: "",
    name: "Files",
    parent: null,
    home: null,
    roots: [],
    entries: [],
  });
  const [query, setQuery] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const queue = useMemo(
    () => new TransferQueue(services, reportError),
    [services],
  );
  const transfers = useSyncExternalStore(queue.subscribe, queue.snapshot);
  useEffect(() => {
    queue.activate();
    return () => queue.dispose();
  }, [queue]);
  const [picking, setPicking] = useState(false);
  const transferBusy = picking || transfers.some(pendingTransfer);
  const canUpload =
    connected &&
    !!directory.path &&
    !picking &&
    !!session?.info.capabilities.includes("files.upload");
  const canDownload =
    connected &&
    !picking &&
    !!session?.info.capabilities.includes("files.download");
  async function upload() {
    if (!canUpload) return;
    setPicking(true);
    try {
      queue.enqueue(await services.chooseUploads(directory.path));
    } catch (error) {
      setError(String(error));
    } finally {
      setPicking(false);
    }
  }
  async function download(entry: FileEntry) {
    if (!canDownload || !entry.revision || entry.kind !== "file") return;
    setPicking(true);
    try {
      const ticket = await services.chooseDownload(entry.path, entry.revision);
      if (ticket) queue.enqueue([ticket]);
    } catch (error) {
      setError(String(error));
    } finally {
      setPicking(false);
    }
  }
  const [operation, setOperation] = useState<{
    kind: "mkdir" | "rename" | "delete";
    parent: string;
    entry?: FileEntry;
  } | null>(null);
  const canManage =
    connected &&
    !!directory.path &&
    !loading &&
    !busy &&
    !!session?.info.capabilities.includes("files.manage");
  const hasFileChanges = session?.info.capabilities.some((capability) =>
    [
      "files.manage",
      "files.move",
      "files.create",
      "files.edit",
      "files.upload",
    ].includes(capability),
  );
  const [moveTarget, setMoveTarget] = useState<{
    entry: FileEntry;
    parent: string;
    sessionId: number;
    services: AppContext["services"];
  } | null>(null);
  const canMove =
    connected &&
    !!directory.path &&
    !loading &&
    !busy &&
    !!session?.info.capabilities.includes("files.move");
  const canCreate =
    connected &&
    !!directory.path &&
    !loading &&
    !busy &&
    !!session?.info.capabilities.includes("files.create");
  useEffect(() => {
    setDocumentState?.({ dirty: false, busy: busy || transferBusy });
  }, [busy, transferBusy]);
  const [error, setError] = useState("");
  const [document, setDocument] = useState<{
    name: string;
    text: string;
    path: string;
  } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const request = useRef(0);
  const previewRequest = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const pathField = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry?: FileEntry;
  } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const refresh = useRef(() => {});
  refresh.current = () => {
    void navigate(directory.path, false);
  };
  useEffect(
    () =>
      session
        ? watchFileChanges(session.id, () => refresh.current())
        : undefined,
    [session?.id],
  );
  useEffect(() => {
    if (!active) closeMenu();
  }, [active, closeMenu]);
  function back() {
    const previous = history.at(-1);
    if (previous && !loading && connected) {
      setHistory(history.slice(0, -1));
      void navigate(previous, false);
    }
  }
  function parent() {
    if (directory.parent !== null) void navigate(directory.parent);
  }
  async function copyText(text: string) {
    try {
      await clipboard.writeText(text);
    } catch (e) {
      setError(`Copy failed: ${e}`);
    }
  }
  async function clipboardPath() {
    if (!connected) return;
    const current = request.current;
    try {
      const path = await clipboard.readText();
      if (current !== request.current) return;
      if (!path || path.length > 4096 || /[\0\r\n]/.test(path))
        throw new Error("The clipboard must contain one file or folder path.");
      void navigate(path);
    } catch (e) {
      setError(`Cannot open clipboard path: ${e}`);
    }
  }
  async function navigate(path?: string, remember = true) {
    if (!session || !connected) return;
    const current = ++request.current;
    ++previewRequest.current;
    setLoading(true);
    setError("");
    setDocument(null);
    try {
      const result = await services.list(path === "" ? undefined : path);
      if (current !== request.current) return;
      if (remember && directory.path && directory.path !== result.path)
        setHistory((previous) => [...previous, directory.path]);
      setDirectory(result);
      setPathInput(result.path);
      setSelected(null);
    } catch (e) {
      if (current === request.current) setError(String(e));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!connected) setLoading(false);
    else void navigate(directory.path || launch?.path, false);
    return () => {
      ++request.current;
      ++previewRequest.current;
    };
  }, [session?.id, connected]);
  async function open(entry: FileEntry) {
    if (!connected) return;
    if (entry.kind === "directory") {
      void navigate(entry.path);
      return;
    }
    const current = ++previewRequest.current;
    setError("");
    setDocument({
      name: entry.name,
      text: "Loading preview…",
      path: entry.path,
    });
    try {
      const text = await services.preview(entry.path);
      if (current === previewRequest.current)
        setDocument({ name: entry.name, text, path: entry.path });
    } catch (e) {
      if (current === previewRequest.current) {
        setDocument(null);
        setError(String(e));
      }
    }
  }
  const entries = useMemo(
    () => visibleFiles(directory.entries, query, preferences),
    [
      directory.entries,
      query,
      preferences.filesShowHidden,
      preferences.filesSort,
      preferences.filesDescending,
      preferences.filesFoldersFirst,
    ],
  );
  useEffect(() => {
    if (selected && !entries.some((entry) => entry.path === selected))
      setSelected(null);
  }, [selected, directory, query, preferences.filesShowHidden]);
  function menuActions(entry?: FileEntry): MenuAction[] {
    return [
      {
        id: "upload",
        label: "Upload files…",
        disabled: !canUpload,
        run: () => void upload(),
      },
      ...(entry
        ? [
            {
              id: "download",
              label: "Download…",
              disabled:
                !canDownload || entry.kind !== "file" || !entry.revision,
              run: () => void download(entry),
            },
          ]
        : []),
      {
        id: "mkdir",
        label: "New folder",
        disabled: !canManage,
        run: () => setOperation({ kind: "mkdir", parent: directory.path }),
      },
      {
        id: "new-file",
        label: "New text file",
        disabled: !canCreate || !openApp,
        run: () => openApp?.("editor", { directory: directory.path }),
      },
      ...(entry && entry.kind !== "directory" && openApp
        ? [
            {
              id: "edit",
              label: "Open in text editor",
              disabled: !connected,
              run: () => openApp("editor", { path: entry.path }),
            },
          ]
        : []),
      ...(entry
        ? [
            {
              id: "open",
              label:
                entry.kind === "directory" ? "Open folder" : "Preview file",
              shortcut: "Enter",
              disabled: !connected,
              run: () => void open(entry),
            },
            ...(entry.kind === "directory" && openApp
              ? [
                  {
                    id: "new-window",
                    label: "Open in new window",
                    disabled: !connected,
                    run: () => openApp("files", { path: entry.path }),
                  },
                ]
              : []),
            {
              id: "copy-name",
              label: "Copy name",
              run: () => void copyText(entry.name),
            },
            {
              id: "copy-path",
              label: "Copy path",
              shortcut: "Ctrl+C",
              run: () => void copyText(entry.path),
            },
            {
              id: "rename",
              label: "Rename",
              shortcut: "F2",
              disabled: !canManage || !entry.revision,
              run: () =>
                setOperation({ kind: "rename", parent: directory.path, entry }),
            },
            {
              id: "move",
              label: "Move to folder…",
              disabled: !canMove || !entry.revision,
              run: () =>
                setMoveTarget({
                  entry,
                  parent: directory.path,
                  sessionId: session!.id,
                  services,
                }),
            },
            {
              id: "delete",
              label:
                entry.kind === "directory" ? "Delete empty folder…" : "Delete…",
              shortcut: "Delete",
              disabled: !canManage || !entry.revision,
              run: () =>
                setOperation({ kind: "delete", parent: directory.path, entry }),
            },
          ]
        : [
            {
              id: "copy-folder",
              label: "Copy folder path",
              shortcut: "Ctrl+C",
              run: () => void copyText(directory.path),
            },
          ]),
      {
        id: "back",
        label: "Back",
        shortcut: "Alt+←",
        separatorBefore: true,
        disabled: !connected || !history.length || loading,
        run: back,
      },
      {
        id: "parent",
        label: "Parent folder",
        shortcut: "Alt+↑",
        disabled: !connected || loading || directory.parent === null,
        run: parent,
      },
      {
        id: "refresh",
        label: "Refresh",
        shortcut: "F5",
        disabled: !connected || loading,
        run: () => void navigate(directory.path, false),
      },
      {
        id: "clipboard-path",
        label: "Go to clipboard path",
        separatorBefore: true,
        disabled: !connected || loading,
        run: () => void clipboardPath(),
      },
      {
        id: "hidden-files",
        label: preferences.filesShowHidden
          ? "Hide hidden files"
          : "Show hidden files",
        separatorBefore: true,
        run: () =>
          setPreference("filesShowHidden", !preferences.filesShowHidden),
      },
    ];
  }
  return (
    <div
      className={`files-app ${preferences.filesCompact ? "compact-files" : ""}`}
      ref={root}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('[role="menu"],dialog')) return;
        const command = event.ctrlKey || event.metaKey;
        if (command && event.key.toLowerCase() === "l") {
          event.preventDefault();
          pathField.current?.focus();
          pathField.current?.select();
          return;
        }
        if (target.closest("input,textarea")) return;
        if (command && event.key.toLowerCase() === "c") {
          event.preventDefault();
          void copyText(
            (document && window.getSelection()?.toString()) ||
              selected ||
              directory.path,
          );
        } else if (
          (event.key === "F2" || event.key === "Delete") &&
          canManage &&
          !document
        ) {
          const entry = entries.find((entry) => entry.path === selected);
          if (entry?.revision) {
            event.preventDefault();
            setOperation({
              kind: event.key === "F2" ? "rename" : "delete",
              parent: directory.path,
              entry,
            });
          }
        } else if (event.key === "F5") {
          event.preventDefault();
          if (!loading) void navigate(directory.path, false);
        } else if (event.altKey && event.key === "ArrowLeft") {
          event.preventDefault();
          back();
        } else if (event.altKey && event.key === "ArrowUp") {
          event.preventDefault();
          if (!loading) parent();
        } else if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
          const bounds = target.getBoundingClientRect();
          setMenu({
            x: bounds.left + 12,
            y: bounds.bottom,
            entry: entries.find((e) => e.path === selected),
          });
        }
      }}
    >
      <aside className="file-sidebar">
        <p className="eyebrow">PLACES</p>
        {directory.home && (
          <button
            className={directory.path === directory.home.path ? "selected" : ""}
            disabled={!connected}
            onClick={() => void navigate(directory.home!.path)}
          >
            <Home size={16} /> {directory.home.name}
          </button>
        )}
        {directory.roots.map((root) => (
          <button
            key={root.path}
            className={directory.path === root.path ? "selected" : ""}
            disabled={!connected}
            onClick={() => void navigate(root.path)}
          >
            <Server size={16} /> {root.name}
          </button>
        ))}
        <div className="sidebar-spacer" />
        <div className="volume">
          <span className="volume-icon">
            <Server size={19} />
          </span>
          <div>
            <strong>{session?.info.hostname}</strong>
            <small>
              {!connected
                ? "File access unavailable"
                : preview
                  ? "Sample filesystem"
                  : hasFileChanges
                    ? "File access"
                    : "Read-only access"}
            </small>
          </div>
        </div>
      </aside>
      <div className="file-main">
        <div className="file-toolbar">
          <button
            className="icon-button"
            aria-label="Upload files"
            title="Upload files"
            disabled={!canUpload}
            onClick={() => void upload()}
          >
            <Upload size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Download selected file"
            title="Download selected file"
            disabled={
              !canDownload ||
              !entries.some(
                (entry) =>
                  entry.path === selected &&
                  entry.kind === "file" &&
                  entry.revision,
              )
            }
            onClick={() => {
              const entry = entries.find((entry) => entry.path === selected);
              if (entry) void download(entry);
            }}
          >
            <Download size={16} />
          </button>
          <button
            className="icon-button"
            title="Back"
            aria-label="Back"
            disabled={!connected || !history.length || loading}
            onClick={back}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            className="icon-button"
            title="Parent folder"
            aria-label="Parent folder"
            disabled={!connected || loading || directory.parent === null}
            onClick={parent}
          >
            <ArrowUp size={17} />
          </button>
          <form
            className="path-bar"
            onSubmit={(e) => {
              e.preventDefault();
              void navigate(pathInput);
            }}
          >
            <Folder size={15} />
            <input
              ref={pathField}
              aria-label="Remote path"
              readOnly={!connected}
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
            />
          </form>
          <button
            className="icon-button"
            title="Refresh"
            aria-label="Refresh directory"
            disabled={!connected || loading}
            onClick={() => void navigate(directory.path, false)}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
          <button
            className="icon-button"
            aria-label="Folder actions"
            title="Folder actions"
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenu({ x: bounds.left, y: bounds.bottom });
            }}
          >
            <MoreHorizontal size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="New folder"
            title="New folder"
            disabled={!canManage}
            onClick={() =>
              setOperation({ kind: "mkdir", parent: directory.path })
            }
          >
            <FolderPlus size={17} />
          </button>
        </div>
        <div className="folder-heading">
          <div>
            <h2>
              {directory.home?.path === directory.path
                ? directory.home.name
                : directory.name}
            </h2>
            <p>
              {preview
                ? "A little room for everything."
                : "Your files, directly over SSH."}
            </p>
          </div>
          <label className="file-search">
            <Search size={15} />
            <input
              placeholder="Filter files"
              aria-label="Filter files"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <div role="alert" className="inline-error">
            {error}
          </div>
        )}
        {document ? (
          <div className="document-preview">
            <div>
              <span>
                <Eye size={14} /> {document.name}
              </span>
              <button
                className="icon-button"
                aria-label="Close preview"
                onClick={() => {
                  ++previewRequest.current;
                  setDocument(null);
                }}
              >
                <X size={16} />
              </button>
            </div>
            <pre
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY });
              }}
            >
              {document.text}
            </pre>
          </div>
        ) : (
          <div
            className="file-table"
            aria-busy={loading}
            onContextMenu={(event) => {
              if ((event.target as HTMLElement).closest(".file-row")) return;
              event.preventDefault();
              setSelected(null);
              setMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            <div className="file-table-head">
              <span>Name</span>
              <span>Modified</span>
              <span>Size</span>
            </div>
            {loading ? (
              <div className="file-message">
                <LoaderCircle className="spin" size={22} />
                Reading directory…
              </div>
            ) : entries.length === 0 ? (
              <div className="file-message">
                <Folder size={28} />
                {query
                  ? "No matching files"
                  : directory.entries.length
                    ? "No visible files · hidden files are filtered"
                    : "This folder is empty"}
              </div>
            ) : (
              entries.map((entry) => {
                const Icon =
                  entry.kind === "directory"
                    ? Folder
                    : /\.(yaml|json|toml|sh)$/.test(entry.name)
                      ? FileCode2
                      : FileText;
                return (
                  <button
                    className={`file-row ${selected === entry.path ? "active" : ""}`}
                    key={entry.path}
                    onClick={() => setSelected(entry.path)}
                    onFocus={() => setSelected(entry.path)}
                    aria-pressed={selected === entry.path}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelected(entry.path);
                      event.currentTarget.focus();
                      setMenu({ x: event.clientX, y: event.clientY, entry });
                    }}
                    onDoubleClick={() => void open(entry)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void open(entry);
                      }
                      const index = entries.indexOf(entry);
                      const next =
                        e.key === "ArrowDown"
                          ? Math.min(entries.length - 1, index + 1)
                          : e.key === "ArrowUp" && !e.altKey
                            ? Math.max(0, index - 1)
                            : e.key === "Home"
                              ? 0
                              : e.key === "End"
                                ? entries.length - 1
                                : -1;
                      if (next >= 0) {
                        e.preventDefault();
                        root.current
                          ?.querySelectorAll<HTMLButtonElement>(".file-row")
                          [next]?.focus();
                      }
                    }}
                  >
                    <span>
                      <Icon
                        size={20}
                        className={
                          entry.kind === "directory"
                            ? "folder-icon"
                            : "file-icon"
                        }
                      />
                      <span>{entry.name}</span>
                      {entry.kind === "symlink" && <small>link</small>}
                    </span>
                    <span>
                      {entry.modified
                        ? new Date(entry.modified * 1000).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          )
                        : "—"}
                    </span>
                    <span>
                      {entry.kind === "directory" ? "—" : size(entry.size)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
        {transfers.length > 0 && (
          <TransferPanel rows={transfers} queue={queue} />
        )}
        <footer className="files-footer">
          <span>{entries.length} items</span>
          {selected && (
            <button
              disabled={!connected}
              onClick={() => {
                const entry = entries.find((e) => e.path === selected);
                if (entry) void open(entry);
              }}
            >
              Open selected <ChevronRight size={12} />
            </button>
          )}
          <span>
            {!connected
              ? "Cached listing · file access unavailable"
              : busy
                ? "Working…"
                : hasFileChanges
                  ? "Remote filesystem"
                  : "Read-only explorer"}
          </span>
        </footer>
      </div>
      {menu && (
        <ContextMenu
          {...menu}
          label={document ? "Preview actions" : "File actions"}
          close={closeMenu}
          actions={
            document
              ? [
                  {
                    id: "copy-text",
                    label: "Copy text",
                    run: () =>
                      void copyText(
                        window.getSelection()?.toString() || document.text,
                      ),
                  },
                  {
                    id: "copy-document-path",
                    label: "Copy file path",
                    run: () => void copyText(document.path),
                  },
                  {
                    id: "close-preview",
                    label: "Close preview",
                    run: () => {
                      ++previewRequest.current;
                      setDocument(null);
                    },
                  },
                ]
              : menuActions(menu.entry)
          }
        />
      )}
      {moveTarget && (
        <MoveFileDialog
          entry={moveTarget.entry}
          initialParent={moveTarget.parent}
          services={moveTarget.services}
          disabled={
            !connected ||
            session?.id !== moveTarget.sessionId ||
            !session.info.capabilities.includes("files.move")
          }
          close={() => setMoveTarget(null)}
          setBusy={setBusy}
        />
      )}
      {operation && (
        <FileActionDialog
          title={
            operation.kind === "mkdir"
              ? "New folder"
              : operation.kind === "rename"
                ? "Rename item"
                : "Delete remote item?"
          }
          description={
            operation.kind === "delete"
              ? `Delete this ${operation.entry?.kind === "directory" ? "empty folder" : operation.entry?.kind === "symlink" ? "link (its target is kept)" : "file"} permanently? There is no remote trash or undo.`
              : `In ${operation.parent}. Existing items are never replaced.`
          }
          initialName={
            operation.kind === "delete"
              ? operation.entry!.path
              : (operation.entry?.name ?? "New folder")
          }
          readOnlyName={operation.kind === "delete"}
          destructive={operation.kind === "delete"}
          confirmLabel={
            operation.kind === "mkdir"
              ? "Create folder"
              : operation.kind === "rename"
                ? "Rename"
                : "Delete permanently"
          }
          close={() => setOperation(null)}
          setBusy={setBusy}
          disabled={!connected}
          execute={async (name) => {
            if (operation.kind === "mkdir")
              await services.makeDirectory(operation.parent, name);
            else if (operation.kind === "rename")
              await services.renameEntry(
                operation.entry!.path,
                name,
                operation.entry!.revision!,
              );
            else
              await services.removeEntry(
                operation.entry!.path,
                operation.entry!.revision!,
              );
            setError("");
          }}
        />
      )}
    </div>
  );
}
