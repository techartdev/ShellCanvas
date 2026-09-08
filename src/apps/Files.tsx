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
  ArrowDown,
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
  Scissors,
  ClipboardPaste,
  Copy,
} from "lucide-react";
import type { AppContext, Directory, FileEntry } from "../sdk";
import { ContextMenu, type MenuAction } from "../components/ContextMenu";
import { clipboard } from "../clipboard";
import { fileClipboard } from "../file-clipboard";
import { usePreferences } from "../preferences";
import { visibleFiles } from "../file-view";
import { FileActionDialog } from "../components/FileActionDialog";
import { MoveFileDialog } from "../components/MoveFileDialog";
import { watchFileChanges, watchFileLocations } from "../file-events";
import { relocateNavigation, trackedNavigation } from "../file-navigation";
import { TransferQueue, pendingTransfer } from "../transfer-queue";
import { TransferPanel } from "../components/TransferPanel";
import { selectFiles } from "../file-selection";
import { DeleteFilesDialog } from "../components/DeleteFilesDialog";
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
  const {
    values: preferences,
    set: setPreference,
    error: preferenceError,
    blocked: preferencesBlocked,
  } = usePreferences();
  const cutClipboard = useMemo(() => fileClipboard(services), [services]);
  const cutState = useSyncExternalStore(
    cutClipboard.subscribe,
    cutClipboard.snapshot,
  );
  const currentServices = useRef(services);
  currentServices.current = services;
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
  const [selection, setSelection] = useState<string[]>([]);
  const selectionAnchor = useRef<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    entries: Readonly<FileEntry>[];
    services: AppContext["services"];
    sessionId: number;
  } | null>(null);
  const [reading, setLoading] = useState(true);
  const [relocating, setRelocating] = useState(false);
  const relocatingRef = useRef(false);
  const loading = reading || relocating;
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
  const copyEpoch = useRef(0);
  const [systemCopyNotice, setSystemCopyNotice] = useState("");
  useEffect(() => {
    if (!services.systemFileClipboard || !connected) return;
    let alive = true;
    const refreshClipboard = () => {
      const expected = cutClipboard.snapshot().systemSequence;
      if (expected === undefined) return;
      void services
        .systemClipboardSequence()
        .then((sequence) => {
          if (
            alive &&
            expected === cutClipboard.snapshot().systemSequence &&
            sequence !== expected
          ) {
            cutClipboard.clear();
            setSystemCopyNotice("");
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", refreshClipboard);
    return () => {
      alive = false;
      window.removeEventListener("focus", refreshClipboard);
    };
  }, [services, connected, cutClipboard]);
  const transferBusy = picking || transfers.some(pendingTransfer);
  const canUpload =
    connected &&
    !!directory.path &&
    !picking &&
    !relocating &&
    !!session?.info.capabilities.includes("files.upload");
  const canDownload =
    connected &&
    !picking &&
    !relocating &&
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
  async function downloadSelection() {
    if (!canDownload || !selectedEntries.length) return;
    if (selectedEntries.length === 1) return download(selectedEntries[0]);
    if (
      selectedEntries.length > 16 ||
      selectedEntries.some((entry) => entry.kind !== "file" || !entry.revision)
    ) {
      setError("Select up to 16 regular files to download together.");
      return;
    }
    setPicking(true);
    try {
      queue.enqueue(
        await services.chooseDownloads(
          selectedEntries.map((entry) => ({
            path: entry.path,
            revision: entry.revision!,
          })),
        ),
      );
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
      "files.copy",
    ].includes(capability),
  );
  const [moveTarget, setMoveTarget] = useState<{
    copy?: boolean;
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
    setDocumentState?.({
      dirty: false,
      busy: busy || transferBusy || relocating || cutState.working,
    });
  }, [busy, transferBusy, relocating, cutState.working]);
  const [error, setError] = useState("");
  const [document, setDocument] = useState<{
    name: string;
    text: string;
    path: string;
  } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const request = useRef(0);
  const previewRequest = useRef(0);
  const previewPending = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const pathField = useRef<HTMLInputElement>(null);
  const previewBody = useRef<HTMLPreElement>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry?: FileEntry;
    sort?: boolean;
  } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const view = useRef({
    directory,
    pathInput,
    selected,
    selection,
    document,
    history,
  });
  view.current = {
    directory,
    pathInput,
    selected,
    selection,
    document,
    history,
  };
  const transferState = useRef(transferBusy);
  transferState.current = transferBusy;
  const keepPreview = useRef(true);
  const refresh = useRef((_preservePreview = false) => {});
  refresh.current = (preservePreview = false) => {
    if (relocatingRef.current) {
      if (!preservePreview) keepPreview.current = false;
      return;
    }
    void navigate(view.current.directory.path, false, {
      background: true,
      preservePreview,
    });
  };
  useEffect(() => {
    relocatingRef.current = false;
    setRelocating(false);
    if (!session) return;
    return watchFileLocations(session.id, {
      snapshot: () => ({
        paths: trackedNavigation(view.current),
        busy: transferState.current,
      }),
      pending: (value) => {
        relocatingRef.current = value;
        setRelocating(value);
        if (value) {
          ++request.current;
          ++previewRequest.current;
          setLoading(false);
          closeMenu();
          keepPreview.current = !previewPending.current;
          if (previewPending.current) {
            view.current.document = null;
            setDocument(null);
          }
          previewPending.current = false;
        } else refresh.current(keepPreview.current);
      },
      relocated: (mappings) => {
        const next = relocateNavigation(view.current, mappings);
        view.current = { ...next, selection: next.selection ?? [] };
        setDirectory(next.directory);
        setHistory(next.history);
        setPathInput(next.pathInput);
        setSelected(next.selected);
        setSelection(next.selection ?? []);
        selectionAnchor.current = next.selected;
        setDocument(next.document);
      },
    });
  }, [session?.id]);
  useEffect(
    () =>
      session
        ? watchFileChanges(session.id, (kind) =>
            refresh.current(kind === "relocation"),
          )
        : undefined,
    [session?.id],
  );
  useEffect(() => {
    if (!active) closeMenu();
  }, [active, closeMenu]);
  function back() {
    const previous = history.at(-1);
    if (previous && !loading && connected) {
      void navigate(previous, false, { back: true });
    }
  }
  function parent() {
    if (directory.parent !== null) void navigate(directory.parent);
  }
  async function copyText(text: string) {
    const epoch = ++copyEpoch.current;
    try {
      await clipboard.writeText(text);
      if (epoch === copyEpoch.current && services.systemFileClipboard) {
        cutClipboard.clear();
        setSystemCopyNotice("");
      }
      setError((previous) =>
        previous.startsWith("Copy failed:") ? "" : previous,
      );
    } catch (e) {
      setError(`Copy failed: ${e}`);
    }
  }
  function previewText() {
    const selection = window.getSelection();
    const text =
      selection &&
      previewBody.current?.contains(selection.anchorNode) &&
      previewBody.current?.contains(selection.focusNode)
        ? selection.toString()
        : "";
    return text || document?.text || "";
  }
  function copySelection() {
    if (document) {
      void copyText(previewText());
      return;
    }
    if (!selectedEntries.length) {
      void copyText(directory.path);
      return;
    }
    void copyFiles(selectedEntries);
  }
  const copyAvailable =
    connected &&
    !picking &&
    !loading &&
    !cutState.working &&
    (session?.info.capabilities.includes("files.copy") ||
      (services.systemFileClipboard &&
        session?.info.capabilities.includes("files.download")));
  async function copyFiles(items: FileEntry[]) {
    if (!copyAvailable) return;
    const epoch = ++copyEpoch.current;
    try {
      cutClipboard.copy(items, directory.path);
      setError("");
      setSystemCopyNotice("");
      if (
        services.systemFileClipboard &&
        session?.info.capabilities.includes("files.download")
      ) {
        setPicking(true);
        const sequence = await services.copyToSystem(
          items.map((entry) => ({
            path: entry.path,
            revision: entry.revision!,
          })),
        );
        if (
          epoch === copyEpoch.current &&
          currentServices.current === services
        ) {
          cutClipboard.syncSystem(sequence);
          setSystemCopyNotice(
            "Also ready to paste in Windows Explorer · keep this app and connection open",
          );
        }
      }
    } catch (error) {
      if (epoch === copyEpoch.current && currentServices.current === services)
        setError(String(error));
    } finally {
      if (currentServices.current === services) setPicking(false);
    }
  }
  async function cut(entry: FileEntry) {
    if (!canMove || picking || cutState.working || !entry.revision) return;
    const epoch = ++copyEpoch.current;
    setError("");
    setSystemCopyNotice("");
    cutClipboard.cut(entry, directory.path);
    if (!services.systemFileClipboard) return;
    setPicking(true);
    try {
      const sequence = await services.cutToSystem(entry.path, entry.revision);
      if (epoch === copyEpoch.current && currentServices.current === services) {
        cutClipboard.syncSystem(sequence);
        setSystemCopyNotice(
          entry.kind === "file"
            ? "Pasting in Explorer copies the file and keeps its remote source"
            : "Folder moves are available within this workspace",
        );
      }
    } catch (error) {
      if (epoch === copyEpoch.current && currentServices.current === services)
        setError(String(error));
    } finally {
      if (currentServices.current === services) setPicking(false);
    }
  }
  function canRemotePasteInto(parent: string) {
    if (cutState.copies?.length)
      return (
        connected &&
        !!session?.info.capabilities.includes("files.copy") &&
        !loading &&
        !busy &&
        !transferBusy &&
        !cutState.working &&
        !!parent &&
        cutState.copies.every(
          (item) => item.parent !== parent && item.entry.path !== parent,
        )
      );
    return (
      canMove &&
      !transferBusy &&
      !cutState.working &&
      !!cutState.item &&
      parent !== cutState.item.parent &&
      parent !== cutState.item.entry.path
    );
  }
  function canPasteInto(parent: string) {
    return (
      canRemotePasteInto(parent) ||
      (!!services.systemFileClipboard &&
        canUpload &&
        !!parent &&
        !loading &&
        !busy &&
        !transferBusy &&
        !cutState.working)
    );
  }
  async function pasteInto(parent: string) {
    if (!canPasteInto(parent)) return;
    setError("");
    setPicking(true);
    try {
      if (services.systemFileClipboard) {
        const sequence = await services.systemClipboardSequence();
        if (sequence !== cutClipboard.snapshot().systemSequence) {
          cutClipboard.clear();
          setSystemCopyNotice("");
          if (!session?.info.capabilities.includes("files.upload"))
            throw new Error(
              "This host does not support uploading clipboard files.",
            );
          const tickets = await services.pasteSystemFiles(parent);
          if (tickets === null)
            throw new Error(
              "Copy files in Windows Explorer first. Clipboard text can be pasted in a terminal or editor.",
            );
          queue.enqueue(tickets);
          return;
        }
      }
      if (!canRemotePasteInto(parent))
        throw new Error(
          "Choose a different destination folder for these files.",
        );
      if (cutState.copies?.length)
        queue.enqueue(await cutClipboard.prepareCopies(parent, services));
      else await cutClipboard.paste(parent);
    } catch (error) {
      if (
        currentServices.current === services &&
        !cutClipboard.snapshot().error
      )
        setError(String(error));
    } finally {
      if (currentServices.current === services) setPicking(false);
    }
  }
  async function clipboardPath() {
    if (!connected) return;
    const current = request.current;
    try {
      const path = await clipboard.readText();
      if (current !== request.current) return;
      if (!path || path.length > 4096 || /[\0\r\n]/.test(path))
        throw new Error("The clipboard must contain one folder path.");
      void navigate(path);
    } catch (e) {
      setError(`Cannot open clipboard path: ${e}`);
    }
  }
  async function navigate(
    path?: string,
    remember = true,
    options: {
      background?: boolean;
      preservePreview?: boolean;
      back?: boolean;
    } = {},
  ) {
    if (!session || !connected || relocatingRef.current) return;
    const current = ++request.current;
    ++previewRequest.current;
    previewPending.current = false;
    setLoading(true);
    setError("");
    if (!options.preservePreview) {
      view.current.document = null;
      setDocument(null);
    }
    try {
      const result = await services.list(path === "" ? undefined : path);
      if (current !== request.current) return;
      const previous = view.current;
      const nextHistory = options.back
        ? previous.history.slice(0, -1)
        : remember &&
            previous.directory.path &&
            previous.directory.path !== result.path
          ? [...previous.history.slice(-49), previous.directory.path]
          : previous.history;
      const nextInput =
        options.background && previous.pathInput !== previous.directory.path
          ? previous.pathInput
          : result.path;
      const preserveSelection =
        previous.directory.path === result.path &&
        (options.background || !remember);
      const nextSelected =
        preserveSelection &&
        result.entries.some((entry) => entry.path === previous.selected)
          ? previous.selected
          : null;
      const nextSelection = preserveSelection
        ? previous.selection.filter((path) =>
            result.entries.some((entry) => entry.path === path),
          )
        : [];
      view.current = {
        ...previous,
        directory: result,
        history: nextHistory,
        pathInput: nextInput,
        selected: nextSelected,
        selection: nextSelection,
      };
      setHistory(nextHistory);
      setDirectory(result);
      setPathInput(nextInput);
      setSelected(nextSelected);
      setSelection(nextSelection);
      if (!options.background) selectionAnchor.current = null;
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
    if (!connected || relocatingRef.current) return;
    if (entry.kind === "directory") {
      void navigate(entry.path);
      return;
    }
    const current = ++previewRequest.current;
    previewPending.current = true;
    setError("");
    view.current.document = {
      name: entry.name,
      text: "Loading preview…",
      path: entry.path,
    };
    setDocument({
      name: entry.name,
      text: "Loading preview…",
      path: entry.path,
    });
    try {
      const text = await services.preview(entry.path);
      if (current === previewRequest.current) {
        view.current.document = { name: entry.name, text, path: entry.path };
        setDocument(view.current.document);
      }
    } catch (e) {
      if (current === previewRequest.current) {
        view.current.document = null;
        setDocument(null);
        setError(String(e));
      }
    } finally {
      if (current === previewRequest.current) previewPending.current = false;
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
  const selectedEntries = entries.filter((entry) =>
    selection.includes(entry.path),
  );
  const singleEntry =
    selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  function choose(entry: FileEntry, toggle = false, range = false) {
    const anchor = selectionAnchor.current;
    setSelection((current) =>
      selectFiles(
        current,
        entries.map((item) => item.path),
        entry.path,
        anchor,
        toggle,
        range,
      ),
    );
    setSelected(entry.path);
    if (!range || !selectionAnchor.current)
      selectionAnchor.current = entry.path;
  }
  function reviewDelete(items: FileEntry[]) {
    if (!canManage || !session || !items.length) return;
    if (items.length > 100 || items.some((entry) => !entry.revision)) {
      setError(
        "Select up to 100 items with current revisions. Refresh the folder if needed.",
      );
      return;
    }
    setDeleteTarget({
      entries: items.map((entry) => Object.freeze({ ...entry })),
      services,
      sessionId: session.id,
    });
  }
  useEffect(() => {
    if (!loading)
      setSelection((current) => {
        const next = current.filter((path) =>
          entries.some((entry) => entry.path === path),
        );
        return next.length === current.length ? current : next;
      });
    if (
      !loading &&
      selected &&
      !entries.some((entry) => entry.path === selected)
    )
      setSelected(null);
  }, [selected, directory, query, preferences.filesShowHidden, loading]);
  function menuActions(entry?: FileEntry): MenuAction[] {
    if (selectedEntries.length > 1)
      return [
        {
          id: "copy-files",
          label: `Copy ${selectedEntries.length} files`,
          shortcut: "Ctrl+C",
          disabled:
            !copyAvailable ||
            selectedEntries.length > 16 ||
            selectedEntries.some(
              (entry) => entry.kind !== "file" || !entry.revision,
            ),
          run: copySelection,
        },
        {
          id: "download-files",
          label: "Download files…",
          disabled:
            !canDownload ||
            selectedEntries.length > 16 ||
            selectedEntries.some(
              (entry) => entry.kind !== "file" || !entry.revision,
            ),
          run: () => void downloadSelection(),
        },
        {
          id: "copy-names",
          label: `Copy ${selectedEntries.length} names`,
          run: () =>
            void copyText(selectedEntries.map((item) => item.name).join("\n")),
        },
        {
          id: "copy-paths",
          label: `Copy ${selectedEntries.length} paths`,
          run: () =>
            void copyText(
              selectedEntries.map((entry) => entry.path).join("\n"),
            ),
        },
        {
          id: "delete-selection",
          label: `Delete ${selectedEntries.length} items…`,
          shortcut: "Delete",
          disabled:
            !canManage ||
            selectedEntries.length > 100 ||
            selectedEntries.some((item) => !item.revision),
          run: () => reviewDelete(selectedEntries),
        },
        {
          id: "select-all",
          label: "Select all",
          shortcut: "Ctrl+A",
          separatorBefore: true,
          run: () => setSelection(entries.map((item) => item.path)),
        },
        {
          id: "clear-selection",
          label: "Clear selection",
          shortcut: "Esc",
          run: () => setSelection([]),
        },
        {
          id: "sort-view",
          label: "Sort and view…",
          separatorBefore: true,
          run: () => {
            if (menu) setMenu({ x: menu.x, y: menu.y, sort: true });
          },
        },
      ];
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
            {
              id: "copy-clipboard",
              label: "Copy",
              shortcut: "Ctrl+C",
              disabled:
                !copyAvailable || entry.kind !== "file" || !entry.revision,
              run: () => void copyFiles([entry]),
            },
            {
              id: "copy-file",
              label: "Copy to folder…",
              disabled:
                !connected ||
                loading ||
                busy ||
                picking ||
                entry.kind !== "file" ||
                !entry.revision ||
                !session?.info.capabilities.includes("files.copy"),
              run: () =>
                setMoveTarget({
                  entry: { ...entry },
                  parent: directory.path,
                  sessionId: session!.id,
                  services,
                  copy: true,
                }),
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
              run: () => void copyText(entry.path),
            },
            {
              id: "cut",
              label: "Cut",
              shortcut: "Ctrl+X",
              disabled: !canMove || !entry.revision || cutState.working,
              run: () => cut(entry),
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
        id: "paste-move",
        label: entry?.kind === "directory" ? "Paste into folder" : "Paste here",
        shortcut: entry?.kind === "directory" ? undefined : "Ctrl+V",
        disabled: !canPasteInto(
          entry?.kind === "directory" ? entry.path : directory.path,
        ),
        run: () =>
          void pasteInto(
            entry?.kind === "directory" ? entry.path : directory.path,
          ),
      },
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
        id: "sort-view",
        label: "Sort and view…",
        separatorBefore: true,
        run: () => {
          if (menu) setMenu({ x: menu.x, y: menu.y, sort: true });
        },
      },
      {
        id: "select-all",
        label: "Select all",
        shortcut: "Ctrl+A",
        disabled: loading || !entries.length,
        separatorBefore: true,
        run: () => setSelection(entries.map((item) => item.path)),
      },
      {
        id: "hidden-files",
        label: preferences.filesShowHidden
          ? "Hide hidden files"
          : "Show hidden files",
        separatorBefore: true,
        disabled: preferencesBlocked,
        run: () =>
          setPreference("filesShowHidden", !preferences.filesShowHidden),
      },
    ];
  }
  function sortBy(key: typeof preferences.filesSort) {
    if (key === preferences.filesSort)
      setPreference("filesDescending", !preferences.filesDescending);
    else setPreference("filesSort", key);
  }
  function sortActions(): MenuAction[] {
    return [
      ...(["name", "modified", "size"] as const).map((key) => ({
        id: `sort-${key}`,
        label: { name: "Name", modified: "Modified", size: "Size" }[key],
        checked: preferences.filesSort === key,
        checkType: "radio" as const,
        group: "Sort by",
        disabled: preferencesBlocked,
        run: () => setPreference("filesSort", key),
      })),
      ...([false, true] as const).map((descending) => ({
        id: descending ? "descending" : "ascending",
        label: descending ? "Descending" : "Ascending",
        checked: preferences.filesDescending === descending,
        checkType: "radio" as const,
        separatorBefore: !descending,
        group: "Order",
        disabled: preferencesBlocked,
        run: () => setPreference("filesDescending", descending),
      })),
      ...(
        [
          ["filesFoldersFirst", "Keep folders first"],
          ["filesShowHidden", "Show hidden files"],
          ["filesCompact", "Compact rows"],
        ] as const
      ).map(([key, label], index) => ({
        id: key,
        label,
        checked: preferences[key],
        separatorBefore: index === 0,
        disabled: preferencesBlocked,
        run: () => setPreference(key, !preferences[key]),
      })),
    ];
  }
  return (
    <div
      className={`files-app ${preferences.filesCompact ? "compact-files" : ""}`}
      ref={root}
      onCopy={(event) => {
        if (
          (event.target as HTMLElement).closest(
            'input,textarea,[contenteditable="true"],[role="menu"],dialog',
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        copySelection();
      }}
      onCut={(event) => {
        if (
          document ||
          (event.target as HTMLElement).closest(
            'input,textarea,[role="menu"],dialog',
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const entry = singleEntry;
        if (entry) cut(entry);
      }}
      onPaste={(event) => {
        if (
          document ||
          (event.target as HTMLElement).closest(
            'input,textarea,[role="menu"],dialog',
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        void pasteInto(directory.path);
      }}
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
        if (
          target.closest(
            'input,textarea,[contenteditable="true"],[role="menu"],dialog',
          )
        )
          return;
        if (command && event.key.toLowerCase() === "c") {
          event.preventDefault();
          copySelection();
        } else if (command && event.key.toLowerCase() === "x" && !document) {
          event.preventDefault();
          const entry = singleEntry;
          if (entry) cut(entry);
        } else if (command && event.key.toLowerCase() === "v" && !document) {
          event.preventDefault();
          void pasteInto(directory.path);
        } else if (command && event.key.toLowerCase() === "a" && !document) {
          event.preventDefault();
          if (!loading) setSelection(entries.map((entry) => entry.path));
        } else if (event.key === "Escape" && !document && selection.length) {
          event.preventDefault();
          setSelection([]);
          if ((cutState.item || cutState.copies?.length) && !cutState.working)
            cutClipboard.clear();
        } else if (
          event.key === "Escape" &&
          !document &&
          (cutState.item || cutState.copies?.length) &&
          !cutState.working
        ) {
          event.preventDefault();
          cutClipboard.clear();
        } else if (
          (event.key === "F2" || event.key === "Delete") &&
          canManage &&
          !document
        ) {
          if (event.key === "Delete" && selectedEntries.length > 1) {
            event.preventDefault();
            reviewDelete(selectedEntries);
            return;
          }
          const entry = singleEntry;
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
            entry: singleEntry,
          });
        }
      }}
    >
      <aside className="file-sidebar">
        <p className="eyebrow">PLACES</p>
        {directory.home && (
          <button
            className={directory.path === directory.home.path ? "selected" : ""}
            title={directory.home.name}
            disabled={!connected || relocating}
            onClick={() => void navigate(directory.home!.path)}
          >
            <Home size={16} /> {directory.home.name}
          </button>
        )}
        {directory.roots.map((root) => (
          <button
            key={root.path}
            className={directory.path === root.path ? "selected" : ""}
            title={root.name}
            disabled={!connected || relocating}
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
            aria-label={
              selectedEntries.length > 1
                ? "Download selected files"
                : "Download selected file"
            }
            title="Download selected files"
            disabled={
              !canDownload ||
              !selectedEntries.length ||
              selectedEntries.length > 16 ||
              selectedEntries.some(
                (entry) => entry.kind !== "file" || !entry.revision,
              )
            }
            onClick={() => {
              void downloadSelection();
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
            aria-label={
              selectedEntries.length ? "Selection actions" : "Folder actions"
            }
            title={
              selectedEntries.length ? "Selection actions" : "Folder actions"
            }
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenu({ x: bounds.left, y: bounds.bottom, entry: singleEntry });
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
            <h2
              title={
                directory.home?.path === directory.path
                  ? directory.home.name
                  : directory.name
              }
            >
              {directory.home?.path === directory.path
                ? directory.home.name
                : directory.name}
            </h2>
            <p>
              {preview
                ? "A little room for everything."
                : "Your files, directly on your host."}
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
        {(cutState.item || cutState.copies?.length || cutState.working) && (
          <div className="file-cut-bar" role="status">
            {cutState.working ? (
              <LoaderCircle size={15} className="spin" />
            ) : cutState.copies?.length ? (
              <Copy size={15} />
            ) : (
              <Scissors size={15} />
            )}
            <div className="file-cut-description">
              <strong>
                {cutState.working
                  ? cutState.copies?.length
                    ? "Preparing copies…"
                    : "Moving item…"
                  : cutState.copies?.length
                    ? `Ready to copy · ${cutState.copies.length} ${cutState.copies.length === 1 ? "file" : "files"}`
                    : `Ready to move · ${cutState.item!.entry.name}`}
              </strong>
              {cutState.item && (
                <span title={cutState.item.entry.path}>
                  {cutState.item.entry.path}
                </span>
              )}
              {systemCopyNotice ? <span>{systemCopyNotice}</span> : null}
            </div>
            <button
              disabled={!canPasteInto(directory.path)}
              onClick={() => void pasteInto(directory.path)}
            >
              <ClipboardPaste size={14} /> Paste here
            </button>
            <button
              className="icon-button"
              aria-label={
                cutState.copies?.length ? "Clear copied files" : "Cancel cut"
              }
              title="Clear file clipboard · Esc"
              disabled={cutState.working}
              onClick={() => cutClipboard.clear()}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {(error || cutState.error || preferenceError) && (
          <div role="alert" className="inline-error">
            {error || cutState.error || preferenceError}
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
                  previewPending.current = false;
                  view.current.document = null;
                  setDocument(null);
                }}
              >
                <X size={16} />
              </button>
            </div>
            <pre
              ref={previewBody}
              tabIndex={0}
              aria-label="File preview text"
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
            onClick={(event) => {
              if (!(event.target as HTMLElement).closest("button"))
                setSelection([]);
            }}
            onContextMenu={(event) => {
              if ((event.target as HTMLElement).closest(".file-row")) return;
              event.preventDefault();
              setSelected(null);
              setSelection([]);
              setMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            <div className="file-table-head">
              {(["name", "modified", "size"] as const).map((key) => {
                const label = {
                  name: "Name",
                  modified: "Modified",
                  size: "Size",
                }[key];
                const selectedSort = preferences.filesSort === key;
                const direction = preferences.filesDescending
                  ? "descending"
                  : "ascending";
                const Icon = preferences.filesDescending ? ArrowDown : ArrowUp;
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={preferencesBlocked}
                    aria-label={`Sort by ${label}${selectedSort ? ` (${direction})` : ""}`}
                    aria-pressed={selectedSort}
                    title={
                      selectedSort
                        ? `${label}: ${direction}. Activate to reverse order.`
                        : `Sort by ${label}`
                    }
                    onClick={() => sortBy(key)}
                  >
                    <span>{label}</span>
                    {selectedSort && <Icon size={12} aria-hidden="true" />}
                  </button>
                );
              })}
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
                    className={`file-row ${selection.includes(entry.path) ? "active" : ""} ${cutState.item?.entry.path === entry.path ? "cut-entry" : ""}`}
                    key={entry.path}
                    onClick={(event) =>
                      choose(
                        entry,
                        event.ctrlKey || event.metaKey,
                        event.shiftKey,
                      )
                    }
                    onFocus={() => setSelected(entry.path)}
                    aria-pressed={selection.includes(entry.path)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelected(entry.path);
                      if (!selection.includes(entry.path)) choose(entry);
                      event.currentTarget.focus();
                      setMenu({ x: event.clientX, y: event.clientY, entry });
                    }}
                    onDoubleClick={() => void open(entry)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void open(entry);
                      }
                      if (e.key === " ") {
                        e.preventDefault();
                        choose(entry, e.ctrlKey || e.metaKey, e.shiftKey);
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
                        if (!(e.ctrlKey || e.metaKey) || e.shiftKey)
                          choose(
                            entries[next],
                            e.ctrlKey || e.metaKey,
                            e.shiftKey,
                          );
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
                      {cutState.item?.entry.path === entry.path && (
                        <small>cut</small>
                      )}
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
          <span aria-live="polite">
            {entries.length} items
            {selectedEntries.length
              ? ` · ${selectedEntries.length} selected`
              : ""}
          </span>
          {singleEntry && (
            <button
              disabled={!connected}
              onClick={() => {
                const entry = singleEntry;
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
          key={menu.sort ? "sort" : "actions"}
          {...menu}
          label={
            menu.sort
              ? "Sort and view"
              : document
                ? "Preview actions"
                : "File actions"
          }
          close={closeMenu}
          actions={
            menu.sort
              ? sortActions()
              : document
                ? [
                    {
                      id: "copy-text",
                      label: "Copy text",
                      run: () => void copyText(previewText()),
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
          copy={moveTarget.copy}
          prepared={(ticket) => queue.enqueue([ticket])}
          disabled={
            !connected ||
            session?.id !== moveTarget.sessionId ||
            services !== moveTarget.services ||
            !session.info.capabilities.includes(
              moveTarget.copy ? "files.copy" : "files.move",
            )
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
      {deleteTarget && (
        <DeleteFilesDialog
          entries={deleteTarget.entries}
          services={deleteTarget.services}
          available={
            connected &&
            services === deleteTarget.services &&
            session?.id === deleteTarget.sessionId &&
            !!session.info.capabilities.includes("files.manage")
          }
          close={() => {
            setDeleteTarget(null);
            refresh.current();
          }}
          setBusy={setBusy}
        />
      )}
    </div>
  );
}
