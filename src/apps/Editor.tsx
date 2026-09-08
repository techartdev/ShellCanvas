// SPDX-License-Identifier: MPL-2.0
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  Copy,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Redo2,
  RefreshCw,
  Save,
  Search,
  Undo2,
  WrapText,
  X,
} from "lucide-react";
import type { AppContext, TextDocument } from "../sdk";
import { clipboard } from "../clipboard";
import { ContextMenu } from "../components/ContextMenu";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  editBuffer,
  lineEnding,
  normaliseText,
  serialiseText,
} from "../editor-state";
import "./Editor.css";

export function Editor({
  launch,
  services,
  active = true,
  connected = true,
  setDocumentState,
}: AppContext) {
  const [document, setDocument] = useState<TextDocument | null>(null);
  const [buffer, edit] = useReducer(editBuffer, {
    text: "",
    past: [],
    future: [],
  });
  const [path, setPath] = useState(launch?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Open a remote text file to begin");
  const [wrap, setWrap] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const currentText = useRef(buffer.text);
  currentText.current = buffer.text;
  const lineCount = useMemo(
    () => buffer.text.split("\n").length,
    [buffer.text],
  );
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );
  const dirty = buffer.text !== normaliseText(document?.text ?? "");
  const canSave =
    !!document?.writable &&
    connected &&
    !busy &&
    dirty &&
    path.trim() === document.path;
  function change(text: string) {
    if (
      text.length > 256 * 1024 ||
      new TextEncoder().encode(text).length > 256 * 1024
    ) {
      setError("The editor is limited to 256 KiB of UTF-8 text.");
      return;
    }
    edit({ type: "change", text });
  }
  const title = document
    ? `${document.path.split("/").pop()} — Editor`
    : "Text editor";
  useEffect(() => {
    setDocumentState?.({ dirty, busy, title });
  }, [dirty, busy, title]);
  useEffect(() => {
    if (!active) closeMenu();
  }, [active, closeMenu]);
  useEffect(() => {
    if (launch?.path) void load(launch.path);
    return () => {
      ++request.current;
    };
  }, []);
  useEffect(() => {
    if (searchOpen) searchField.current?.focus();
  }, [searchOpen]);
  async function load(nextPath: string) {
    if (!connected || !nextPath.trim()) return;
    const current = ++request.current;
    setBusy(true);
    setError("");
    setPendingPath(null);
    try {
      const result = await services.readText(nextPath.trim());
      if (current !== request.current) return;
      setDocument(result);
      setPath(result.path);
      edit({ type: "load", text: result.text });
      setStatus(
        result.writable
          ? "All changes saved"
          : "Remote saving unavailable · copy your draft to keep changes",
      );
    } catch (error) {
      if (current === request.current) setError(String(error));
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  function open(nextPath: string) {
    if (busy) return;
    if (dirty) setPendingPath(nextPath);
    else void load(nextPath);
  }
  async function save() {
    if (!document || !canSave) return;
    const current = request.current;
    const text = serialiseText(buffer.text, lineEnding(document.text));
    setBusy(true);
    setError("");
    try {
      const result = await services.saveText(
        document.path,
        text,
        document.revision,
      );
      if (current !== request.current) return;
      setDocument(result);
      setStatus("Saved to remote host");
    } catch (error) {
      if (current === request.current) setError(String(error));
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  async function copy(all = false, cut = false) {
    const el = textarea.current;
    if (!el) return;
    const start = el.selectionStart,
      end = el.selectionEnd;
    const text = all ? buffer.text : buffer.text.slice(start, end);
    if (!text) return;
    const before = buffer.text;
    try {
      await clipboard.writeText(text);
      if (cut && !busy && currentText.current === before)
        change(before.slice(0, start) + before.slice(end));
    } catch (error) {
      setError(`Clipboard failed: ${error}`);
    }
  }
  async function paste() {
    if (busy) return;
    const el = textarea.current;
    if (!el) return;
    const before = buffer.text,
      start = el.selectionStart,
      end = el.selectionEnd,
      current = request.current;
    try {
      const text = normaliseText(await clipboard.readText());
      if (current !== request.current || currentText.current !== before) return;
      change(before.slice(0, start) + text + before.slice(end));
      requestAnimationFrame(() => {
        el.focus({ preventScroll: true });
        el.setSelectionRange(start + text.length, start + text.length);
      });
    } catch (error) {
      setError(`Paste failed: ${error}`);
    }
  }
  function findNext() {
    if (!search || !textarea.current) return;
    const el = textarea.current;
    const haystack = buffer.text.toLowerCase(),
      needle = search.toLowerCase();
    let index = haystack.indexOf(needle, el.selectionEnd);
    if (index < 0) index = haystack.indexOf(needle);
    if (index < 0) {
      setStatus("No matches");
      return;
    }
    el.focus({ preventScroll: true });
    el.setSelectionRange(index, index + search.length);
    if (!wrap)
      el.scrollTop = Math.max(
        0,
        buffer.text.slice(0, index).split("\n").length * 22 -
          el.clientHeight / 2,
      );
    setStatus(`Match at character ${index + 1}`);
  }
  return (
    <div
      className="editor-app"
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('[role="menu"]')) return;
        const command = event.ctrlKey || event.metaKey;
        if (command && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void save();
        } else if (command && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setSearchOpen(true);
        } else if (event.key === "Escape" && searchOpen) {
          event.preventDefault();
          setSearchOpen(false);
          textarea.current?.focus();
        }
      }}
    >
      <div className="editor-toolbar">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            open(path);
          }}
        >
          <FolderOpen size={15} />
          <input
            aria-label="Editor file path"
            placeholder="Remote file path…"
            value={path}
            disabled={busy}
            onChange={(event) => setPath(event.target.value)}
          />
          <button disabled={busy || !connected || !path.trim()}>Open</button>
        </form>
        <button
          className="editor-save"
          aria-label="Save file"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Save size={15} />
          )}{" "}
          Save
        </button>
        <button
          className="icon-button"
          aria-label="Editor actions"
          onClick={(event) => {
            const r = event.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom });
          }}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>
      <div className="editor-tools">
        <button
          aria-label="Undo edit"
          title="Undo · Ctrl+Z"
          disabled={busy || !buffer.past.length}
          onClick={() => edit({ type: "undo" })}
        >
          <Undo2 size={15} />
        </button>
        <button
          aria-label="Redo edit"
          title="Redo · Ctrl+Shift+Z"
          disabled={busy || !buffer.future.length}
          onClick={() => edit({ type: "redo" })}
        >
          <Redo2 size={15} />
        </button>
        <span className="bar-divider" />
        <button
          aria-label="Find in file"
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search size={14} /> Find
        </button>
        <button
          aria-label="Toggle word wrap"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText size={15} /> Wrap
        </button>
        <button
          aria-label="Reload remote file"
          disabled={busy || !document || !connected}
          onClick={() => document && open(document.path)}
        >
          <RefreshCw size={14} /> Reload
        </button>
        <button aria-label="Copy document" onClick={() => void copy(true)}>
          <Copy size={14} /> Copy all
        </button>
      </div>
      {searchOpen && (
        <div className="editor-search">
          <Search size={14} />
          <input
            ref={searchField}
            aria-label="Find text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                findNext();
              }
            }}
          />
          <span>
            {search
              ? buffer.text.toLowerCase().split(search.toLowerCase()).length - 1
              : 0}{" "}
            matches
          </span>
          <button aria-label="Find next" onClick={findNext}>
            <ArrowDown size={15} />
          </button>
          <button aria-label="Close find" onClick={() => setSearchOpen(false)}>
            <X size={15} />
          </button>
        </div>
      )}
      {!connected && (
        <div className="editor-offline">
          Connection closed. Your draft is still here; copy it before closing
          this workspace.
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className={`editor-buffer ${wrap ? "wrap" : ""}`}>
        {!wrap && (
          <div className="editor-lines" aria-hidden="true" ref={gutter}>
            {lineNumbers}
          </div>
        )}
        <textarea
          ref={textarea}
          aria-label="Editor content"
          value={buffer.text}
          disabled={busy}
          placeholder="Open a remote file, or write a draft here…"
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          onChange={(event) => change(event.target.value)}
          onScroll={(event) => {
            if (gutter.current)
              gutter.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          onKeyDown={(event) => {
            const command = event.ctrlKey || event.metaKey;
            if (command && ["z", "y"].includes(event.key.toLowerCase())) {
              event.preventDefault();
              edit({
                type:
                  event.shiftKey || event.key.toLowerCase() === "y"
                    ? "redo"
                    : "undo",
              });
            } else if (event.key === "Tab") {
              event.preventDefault();
              const el = event.currentTarget,
                start = el.selectionStart,
                end = el.selectionEnd;
              change(
                buffer.text.slice(0, start) + "  " + buffer.text.slice(end),
              );
              requestAnimationFrame(() =>
                el.setSelectionRange(start + 2, start + 2),
              );
            } else if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenu({ x: bounds.left + 20, y: bounds.top + 20 });
            }
          }}
        />
      </div>
      <footer className="editor-footer">
        <span>{busy ? "Working…" : dirty ? "Unsaved changes" : status}</span>
        <span>
          {lineCount} lines · UTF-8 ·{" "}
          {document ? lineEnding(document.text) : "LF"}
        </span>
      </footer>
      {menu && (
        <ContextMenu
          {...menu}
          label="Editor actions"
          close={closeMenu}
          actions={[
            {
              id: "save",
              label: "Save file",
              shortcut: "Ctrl+S",
              disabled: !canSave,
              run: () => void save(),
            },
            {
              id: "copy",
              label: "Copy selection",
              disabled:
                textarea.current?.selectionStart ===
                textarea.current?.selectionEnd,
              separatorBefore: true,
              run: () => void copy(),
            },
            {
              id: "cut",
              label: "Cut selection",
              disabled:
                busy ||
                textarea.current?.selectionStart ===
                  textarea.current?.selectionEnd,
              run: () => void copy(false, true),
            },
            {
              id: "paste",
              label: "Paste",
              disabled: busy,
              run: () => void paste(),
            },
            {
              id: "all",
              label: "Select all",
              run: () => {
                textarea.current?.focus();
                textarea.current?.select();
              },
            },
            {
              id: "copy-all",
              label: "Copy entire draft",
              run: () => void copy(true),
            },
            {
              id: "undo",
              label: "Undo",
              shortcut: "Ctrl+Z",
              separatorBefore: true,
              disabled: busy || !buffer.past.length,
              run: () => edit({ type: "undo" }),
            },
            {
              id: "redo",
              label: "Redo",
              shortcut: "Ctrl+Shift+Z",
              disabled: busy || !buffer.future.length,
              run: () => edit({ type: "redo" }),
            },
          ]}
        />
      )}
      {pendingPath !== null && (
        <ConfirmDialog
          title="Discard draft and reload?"
          message="Opening a file replaces the current draft. Copy or save your changes first if you want to keep them."
          confirmLabel="Discard and open"
          confirm={() => void load(pendingPath)}
          cancel={() => setPendingPath(null)}
        />
      )}
    </div>
  );
}
