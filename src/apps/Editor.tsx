// SPDX-License-Identifier: MPL-2.0
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  type EditorAction,
} from "../editor-state";
import "./Editor.css";
import { usePreferences } from "../preferences";
import { SaveAsDialog } from "../components/SaveAsDialog";
import { watchFileLocations } from "../file-events";
import { fileSourceKey } from "../workspace-bindings";

export function Editor({
  session,
  launch,
  services,
  system,
  active = true,
  connected = true,
  unavailableReason,
  setDocumentState,
}: AppContext) {
  const { values: preferences, set: setPreference } = usePreferences();
  const [document, setDocument] = useState<TextDocument | null>(null);
  const sourceKey = fileSourceKey(session);
  const [documentSource, setDocumentSource] = useState(sourceKey);
  const launchSource = useRef(sourceKey);
  const sourceChanged = !!document && documentSource !== sourceKey;
  const suggestedDirectory = (
    document ? !sourceChanged : launchSource.current === sourceKey
  )
    ? (document?.parent ?? launch?.directory)
    : undefined;
  const clipboardRevision = useRef(0);
  const clipboardOperation = useRef(0);
  const clipboardScope = useRef({ sessionId: session?.id, connected, active });
  clipboardScope.current = { sessionId: session?.id, connected, active };
  const [buffer, dispatchEdit] = useReducer(editBuffer, {
    text: "",
    past: [],
    future: [],
  });
  function edit(action: EditorAction) {
    // Text equality misses edits followed by undo and identical replacement files.
    ++clipboardRevision.current;
    dispatchEdit(action);
  }
  const [path, setPath] = useState(launch?.path ?? "");
  const [operationBusy, setOperationBusy] = useState(false);
  const busyRef = useRef(false);
  const setBusy = useCallback((value: boolean) => {
    if (value) ++clipboardRevision.current;
    busyRef.current = value;
    setOperationBusy(value);
  }, []);
  const [relocating, setRelocating] = useState(false);
  const relocatingRef = useRef(false);
  const busy = operationBusy || relocating;
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const canCreate =
    connected && !busy && !!session?.info.capabilities.includes("files.create");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Open a remote text file to begin");
  const wrap = preferences.editorWrap;
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (gutter.current && textarea.current)
      gutter.current.scrollTop = textarea.current.scrollTop;
  }, [wrap, preferences.editorLineNumbers, preferences.editorFontSize]);
  const request = useRef(0);
  useLayoutEffect(() => {
    ++request.current;
    setBusy(false);
    setSaveAs(null);
    setPendingPath(null);
  }, [services, setBusy]);
  const previousSource = useRef(sourceKey);
  useLayoutEffect(() => {
    if (previousSource.current !== sourceKey) setPath("");
    previousSource.current = sourceKey;
  }, [sourceKey]);
  const locationState = useRef({
    document,
    path,
    saveAs,
    pendingPath,
    documentSource,
    sourceKey,
  });
  locationState.current = {
    document,
    path,
    saveAs,
    pendingPath,
    documentSource,
    sourceKey,
  };
  useEffect(() => {
    relocatingRef.current = false;
    setRelocating(false);
    if (!session) return;
    return watchFileLocations(session.id, {
      snapshot: () => ({
        paths:
          locationState.current.document &&
          locationState.current.documentSource ===
            locationState.current.sourceKey
            ? [locationState.current.document.path]
            : [],
        busy:
          busyRef.current ||
          locationState.current.saveAs !== null ||
          locationState.current.pendingPath !== null,
      }),
      pending: (value) => {
        relocatingRef.current = value;
        setRelocating(value);
      },
      relocated: (mappings) => {
        const current = locationState.current;
        if (current.documentSource !== current.sourceKey) return;
        const match = mappings.find(
          (m) => m.previous === current.document?.path,
        );
        if (!match || !current.document) return;
        // Keep the original content/revision and undo history: location changes
        // are not permission to adopt a newer remote version.
        const next = { ...current.document, ...match.location };
        locationState.current = {
          ...current,
          document: next,
          path:
            current.path === current.document.path ? next.path : current.path,
        };
        setDocument(next);
        if (current.path === current.document.path) setPath(next.path);
        setStatus("File location updated");
      },
    });
  }, [session?.id, sourceKey]);
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
    !sourceChanged &&
    !!document?.writable &&
    !!session?.info.capabilities.includes("files.edit") &&
    connected &&
    !busy &&
    dirty &&
    path === document.path;
  function change(text: string) {
    if (
      text.length > 256 * 1024 ||
      new TextEncoder().encode(text).length > 256 * 1024
    ) {
      setError("The editor is limited to 256 KiB of UTF-8 text.");
      return false;
    }
    edit({ type: "change", text });
    return true;
  }
  const title = document ? `${document.name} — Editor` : "Text editor";
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
    if (!connected || relocatingRef.current || !nextPath.trim()) return;
    const current = ++request.current;
    setBusy(true);
    setError("");
    setPendingPath(null);
    try {
      const result = await services.readText(nextPath);
      if (current !== request.current) return;
      locationState.current = {
        ...locationState.current,
        document: result,
        path: result.path,
      };
      setDocument(result);
      setDocumentSource(sourceKey);
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
    if (dirty && system) {
      const current = request.current;
      setBusy(true);
      void system.dialogs
        .messageBox({
          title: "Discard draft and open?",
          kind: "warning",
          message:
            "Opening another file replaces this draft. Save or copy your changes first if you want to keep them.",
          buttons: [
            { id: "cancel", label: "Keep editing" },
            { id: "discard", label: "Discard and open", destructive: true },
          ],
          defaultId: "cancel",
          cancelId: "cancel",
        })
        .then((answer) => {
          if (current === request.current && answer === "discard")
            return load(nextPath);
        })
        .catch((error) => {
          if (current === request.current) setError(String(error));
        })
        .finally(() => {
          if (current === request.current) setBusy(false);
        });
    } else if (dirty) setPendingPath(nextPath);
    else void load(nextPath);
  }
  async function browseOpen() {
    if (!system || busy || !connected) return;
    const current = request.current;
    setBusy(true);
    setError("");
    try {
      const selected = await system.dialogs.openFile({
        title: "Open a text file",
        directory: suggestedDirectory,
      });
      if (current !== request.current || !selected?.[0]) return;
      setBusy(false);
      if (dirty) {
        setBusy(true);
        const answer = await system.dialogs.messageBox({
          title: "Discard draft and open?",
          kind: "warning",
          message: "Opening this file replaces your unsaved draft.",
          buttons: [
            { id: "cancel", label: "Keep editing" },
            { id: "discard", label: "Discard and open", destructive: true },
          ],
          defaultId: "cancel",
          cancelId: "cancel",
        });
        if (current !== request.current || answer !== "discard") return;
      }
      await load(selected[0].path);
    } catch (error) {
      if (current === request.current) setError(String(error));
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  async function save() {
    if (relocatingRef.current) return;
    if (!document && canCreate) {
      void openSaveAs();
      return;
    }
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
      setDocumentSource(sourceKey);
      setStatus("Saved to remote host");
      locationState.current = { ...locationState.current, document: result };
    } catch (error) {
      if (current === request.current) setError(String(error));
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  async function openSaveAs() {
    if (!canCreate || relocatingRef.current) return;
    if (system) {
      const current = request.current;
      setBusy(true);
      setError("");
      try {
        const saved = await system.files.saveTextAs({
          title: "Save text file",
          directory: suggestedDirectory,
          name: document?.name ?? "untitled.txt",
          text: serialiseText(
            buffer.text,
            document ? lineEnding(document.text) : "LF",
          ),
        });
        if (!saved || current !== request.current) return;
        locationState.current = {
          ...locationState.current,
          document: saved,
          path: saved.path,
        };
        setDocument(saved);
        setDocumentSource(sourceKey);
        setPath(saved.path);
        setStatus("Saved to remote host");
      } catch (error) {
        if (current === request.current) setError(String(error));
      } finally {
        if (current === request.current) setBusy(false);
      }
      return;
    }
    const parent = suggestedDirectory;
    if (parent !== undefined && parent !== null) {
      setSaveAs(parent);
      return;
    }
    const current = request.current;
    setBusy(true);
    setError("");
    try {
      const location = await services.list();
      if (current === request.current) setSaveAs(location.path);
    } catch (error) {
      if (current === request.current) setError(String(error));
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  async function copy(all = false, cut = false) {
    const el = textarea.current;
    if (!el || (cut && (busyRef.current || relocatingRef.current))) return;
    const start = el.selectionStart,
      end = el.selectionEnd;
    const text = all ? buffer.text : buffer.text.slice(start, end);
    if (!text) return;
    const before = buffer.text;
    const valid = clipboardGuard(el);
    try {
      await clipboard.writeText(text);
      if (cut && valid()) {
        if (change(before.slice(0, start) + before.slice(end)))
          restoreClipboardCaret(el, start);
      }
    } catch (error) {
      if (valid()) setError(`Clipboard failed: ${error}`);
    }
  }
  async function paste() {
    if (busyRef.current || relocatingRef.current) return;
    const el = textarea.current;
    if (!el) return;
    const before = buffer.text,
      start = el.selectionStart,
      end = el.selectionEnd;
    const valid = clipboardGuard(el);
    try {
      const text = normaliseText(await clipboard.readText());
      if (!valid()) return;
      if (change(before.slice(0, start) + text + before.slice(end)))
        restoreClipboardCaret(el, start + text.length);
    } catch (error) {
      if (valid()) setError(`Paste failed: ${error}`);
    }
  }
  function clipboardGuard(el: HTMLTextAreaElement) {
    // Only the latest clipboard action may edit the document that initiated it.
    const operation = ++clipboardOperation.current;
    const revision = clipboardRevision.current;
    const loadingRequest = request.current;
    const scope = clipboardScope.current;
    const originalDocument = locationState.current.document;
    return () =>
      operation === clipboardOperation.current &&
      revision === clipboardRevision.current &&
      loadingRequest === request.current &&
      originalDocument === locationState.current.document &&
      scope.sessionId === clipboardScope.current.sessionId &&
      scope.connected === clipboardScope.current.connected &&
      clipboardScope.current.active &&
      !busyRef.current &&
      !relocatingRef.current &&
      textarea.current === el &&
      el.isConnected;
  }
  function restoreClipboardCaret(el: HTMLTextAreaElement, position: number) {
    const valid = clipboardGuard(el);
    requestAnimationFrame(() => {
      // A later edit, document switch or focus change must not move its caret.
      if (valid() && el.ownerDocument.activeElement === el)
        el.setSelectionRange(position, position);
    });
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
        buffer.text.slice(0, index).split("\n").length *
          (preferences.editorFontSize + 9) -
          el.clientHeight / 2,
      );
    setStatus(`Match at character ${index + 1}`);
  }
  return (
    <div
      className="editor-app"
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('[role="menu"],dialog'))
          return;
        const command = event.ctrlKey || event.metaKey;
        if (command && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (event.shiftKey && canCreate) void openSaveAs();
          else void save();
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
      {sourceChanged && (
        <div className="editor-source-notice" role="status">
          Connection changed. Your draft is kept here.{" "}
          {canCreate
            ? "Use Save As to save a copy, or open a file from this connection."
            : "Copy your draft to keep it, or open a file from this connection."}
        </div>
      )}
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
        {system && (
          <button
            aria-label="Browse remote files"
            title="Browse remote files"
            disabled={busy || !connected}
            onClick={() => void browseOpen()}
          >
            <FolderOpen size={16} />
          </button>
        )}
        <button
          className="editor-save"
          aria-label="Save file"
          disabled={document ? !canSave : !canCreate}
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
          onClick={() => setPreference("editorWrap", !wrap)}
        >
          <WrapText size={15} /> Wrap
        </button>
        <button
          aria-label="Reload remote file"
          disabled={busy || !document || !connected || sourceChanged}
          onClick={() => document && !sourceChanged && open(document.path)}
        >
          <RefreshCw size={14} /> Reload
        </button>
        <button
          aria-label="Save file as"
          disabled={!canCreate}
          onClick={() => void openSaveAs()}
        >
          <Save size={14} /> Save as
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
          {unavailableReason ||
            "Connection closed. Reconnect this host to continue."}{" "}
          Your draft is still here; copy it before closing this workspace.
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className={`editor-buffer ${wrap ? "wrap" : ""}`}>
        {!wrap && preferences.editorLineNumbers && (
          <div
            className="editor-lines"
            aria-hidden="true"
            ref={gutter}
            style={{
              fontSize: preferences.editorFontSize - 1,
              lineHeight: `${preferences.editorFontSize + 9}px`,
            }}
          >
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
          style={{
            fontSize: preferences.editorFontSize,
            lineHeight: `${preferences.editorFontSize + 9}px`,
            tabSize: preferences.editorIndent === "2" ? 2 : 4,
          }}
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
              const indent =
                preferences.editorIndent === "tab"
                  ? "\t"
                  : " ".repeat(Number(preferences.editorIndent));
              change(
                buffer.text.slice(0, start) + indent + buffer.text.slice(end),
              );
              requestAnimationFrame(() =>
                el.setSelectionRange(
                  start + indent.length,
                  start + indent.length,
                ),
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
              disabled: document ? !canSave : !canCreate,
              run: () => void save(),
            },
            {
              id: "save-as",
              label: "Save as…",
              shortcut: "Ctrl+Shift+S",
              disabled: !canCreate,
              run: () => void openSaveAs(),
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
      {saveAs !== null && (
        <SaveAsDialog
          initialName={document?.name ?? "untitled.txt"}
          initialParent={saveAs}
          services={services}
          connected={connected}
          canReplace={!!session?.info.capabilities.includes("files.edit")}
          text={serialiseText(
            buffer.text,
            document ? lineEnding(document.text) : "LF",
          )}
          close={() => setSaveAs(null)}
          setBusy={setBusy}
          saved={(saved) => {
            locationState.current = {
              ...locationState.current,
              document: saved,
              path: saved.path,
            };
            setDocument(saved);
            setDocumentSource(sourceKey);
            setPath(saved.path);
            setError("");
            setStatus("Saved to remote host");
          }}
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
