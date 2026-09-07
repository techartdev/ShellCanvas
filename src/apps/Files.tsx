// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
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
  RefreshCw,
  Search,
  Server,
  X,
} from "lucide-react";
import type { AppContext, Directory, FileEntry } from "../sdk";
export function parentPath(path: string) {
  return path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
}
function size(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`;
}
export function Files({ session, services, preview }: AppContext) {
  const [directory, setDirectory] = useState<Directory>({
    path: ".",
    entries: [],
  });
  const [query, setQuery] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [document, setDocument] = useState<{
    name: string;
    text: string;
  } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const request = useRef(0);
  const previewRequest = useRef(0);
  async function navigate(path: string, remember = true) {
    if (!session) return;
    const current = ++request.current;
    ++previewRequest.current;
    setLoading(true);
    setError("");
    setDocument(null);
    try {
      const result = await services.list(session.id, path);
      if (current !== request.current) return;
      if (remember && directory.path !== result.path)
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
    void navigate(session?.info.home || ".", false);
    return () => {
      ++request.current;
      ++previewRequest.current;
    };
  }, [session?.id]);
  async function open(entry: FileEntry) {
    if (entry.kind === "directory") {
      void navigate(entry.path);
      return;
    }
    const current = ++previewRequest.current;
    setError("");
    setDocument({ name: entry.name, text: "Loading preview…" });
    try {
      const text = await services.preview(session!.id, entry.path);
      if (current === previewRequest.current)
        setDocument({ name: entry.name, text });
    } catch (e) {
      if (current === previewRequest.current) {
        setDocument(null);
        setError(String(e));
      }
    }
  }
  const entries = directory.entries.filter((entry) =>
    entry.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="files-app">
      <aside className="file-sidebar">
        <p className="eyebrow">PLACES</p>
        <button
          className={directory.path === session?.info.home ? "selected" : ""}
          onClick={() => void navigate(session?.info.home || ".")}
        >
          <Home size={16} /> Home
        </button>
        <button
          className={directory.path === "/" ? "selected" : ""}
          onClick={() => void navigate("/")}
        >
          <Server size={16} /> Filesystem
        </button>
        <div className="sidebar-spacer" />
        <div className="volume">
          <span className="volume-icon">
            <Server size={19} />
          </span>
          <div>
            <strong>{session?.info.hostname}</strong>
            <small>{preview ? "Sample filesystem" : "SFTP · read only"}</small>
          </div>
        </div>
      </aside>
      <div className="file-main">
        <div className="file-toolbar">
          <button
            className="icon-button"
            title="Back"
            aria-label="Back"
            disabled={!history.length || loading}
            onClick={() => {
              const previous = history.at(-1);
              if (previous) {
                setHistory(history.slice(0, -1));
                void navigate(previous, false);
              }
            }}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            className="icon-button"
            title="Parent folder"
            aria-label="Parent folder"
            disabled={loading || directory.path === "/"}
            onClick={() => void navigate(parentPath(directory.path))}
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
              aria-label="Remote path"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
            />
          </form>
          <button
            className="icon-button"
            title="Refresh"
            aria-label="Refresh directory"
            disabled={loading}
            onClick={() => void navigate(directory.path, false)}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
        </div>
        <div className="folder-heading">
          <div>
            <h2>
              {directory.path === session?.info.home
                ? "Home"
                : directory.path.split("/").filter(Boolean).at(-1) ||
                  "Filesystem"}
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
            <pre>{document.text}</pre>
          </div>
        ) : (
          <div className="file-table" aria-busy={loading}>
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
                {query ? "No matching files" : "This folder is empty"}
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
                    onDoubleClick={() => void open(entry)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void open(entry);
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
        <footer className="files-footer">
          <span>{entries.length} items</span>
          {selected && (
            <button
              onClick={() => {
                const entry = entries.find((e) => e.path === selected);
                if (entry) void open(entry);
              }}
            >
              Open selected <ChevronRight size={12} />
            </button>
          )}
          <span>Read-only explorer</span>
        </footer>
      </div>
    </div>
  );
}
