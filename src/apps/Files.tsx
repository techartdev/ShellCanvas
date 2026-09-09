// SPDX-License-Identifier: MPL-2.0
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import type {
  AppContext,
  ClipboardPreparation,
  Directory,
  FileEntry,
} from "../sdk";
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
import { fileSourceKey } from "../workspace-bindings";
import { capabilityOperationReason } from "../sdk";
import { scanDirectory } from "../directory-scan";
import { useVirtualRows } from "../components/useVirtualRows";
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
  const sourceKey = fileSourceKey(session);
  const previousSource = useRef(sourceKey);
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
  const [scanReady, setScanReady] = useState(false);
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
  const preparationRef = useRef<{
    id: string;
    services: typeof services;
  } | null>(null);
  const [preparingClipboard, setPreparingClipboard] = useState(false);
  useEffect(() => {
    setPicking(false);
    setPreparingClipboard(false);
    setSystemCopyNotice("");
    return () => {
      const pending = preparationRef.current;
      if (pending?.services === services) {
        preparationRef.current = null;
        void services.cancelClipboardPreparation(pending.id).catch(() => {});
      }
    };
  }, [services]);
  function beginClipboardPreparation(): ClipboardPreparation {
    const id = crypto.randomUUID();
    preparationRef.current = { id, services };
    setPreparingClipboard(true);
    setSystemCopyNotice("Scanning for Explorer…");
    return {
      id,
      onProgress: (progress) => {
        if (preparationRef.current?.id === id)
          setSystemCopyNotice(
            `Scanning for Explorer · ${(progress.items ?? 0).toLocaleString()} items · ${size(progress.total)}`,
          );
      },
    };
  }
  async function cancelClipboardPreparation() {
    const pending = preparationRef.current;
    if (!pending) return;
    setSystemCopyNotice("Canceling preparation…");
    try {
      await pending.services.cancelClipboardPreparation(pending.id);
    } catch (error) {
      if (preparationRef.current?.id === pending.id) setError(String(error));
    }
  }

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
  const transferable = (entry: FileEntry) =>
    entry.kind === "file" ||
    (entry.kind === "directory" &&
      !!session?.info.capabilities.includes("files.folders"));
  async function upload(folder = false) {
    if (!canUpload) return;
    setPicking(true);
    try {
      queue.enqueue(await services.chooseUploads(directory.path, folder));
    } catch (error) {
      setError(String(error));
    } finally {
      setPicking(false);
    }
  }
  async function download(entry: FileEntry) {
    if (!canDownload || !entry.revision || !transferable(entry)) return;
    setPicking(true);
    try {
      if (entry.kind === "directory") {
        queue.enqueue(
          await services.chooseDownloads([
            { path: entry.path, revision: entry.revision },
          ]),
        );
      } else {
        const ticket = await services.chooseDownload(
          entry.path,
          entry.revision,
        );
        if (ticket) queue.enqueue([ticket]);
      }
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
      selectedEntries.some((entry) => !transferable(entry) || !entry.revision)
    ) {
      setError(
        "Select supported files or folders with a current revision to download together.",
      );
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
      busy:
        busy ||
        transferBusy ||
        relocating ||
        cutState.working ||
        cutState.cleanupPending === true,
    });
  }, [
    busy,
    transferBusy,
    relocating,
    cutState.working,
    cutState.cleanupPending,
  ]);
  const [error, setError] = useState("");
  const [document, setDocument] = useState<{
    name: string;
    text: string;
    path: string;
  } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const request = useRef(0);
  const directoryScan = useRef<AbortController | null>(null);
  const initialLocation = useRef<string | undefined>(undefined);
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
          directoryScan.current?.abort();
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
  }, [session?.id, sourceKey]);
  useEffect(
    () =>
      session
        ? watchFileChanges(session.id, (kind) =>
            refresh.current(kind === "relocation"),
          )
        : undefined,
    [session?.id, sourceKey],
  );
  useEffect(() => {
    if (!active) closeMenu();
  }, [active, closeMenu]);
  function back() {
    const previous = history.at(-1);
    if (previous && !relocating && connected) {
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
    if (!copyAvailable || items.some((entry) => !transferable(entry))) return;
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
          beginClipboardPreparation(),
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
      if (epoch === copyEpoch.current && currentServices.current === services) {
        setError(String(error));
        setSystemCopyNotice("");
      }
    } finally {
      if (currentServices.current === services) {
        setPicking(false);
        preparationRef.current = null;
        setPreparingClipboard(false);
      }
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
      const sequence = await services.cutToSystem(
        entry.path,
        entry.revision,
        beginClipboardPreparation(),
        !!session?.info.capabilities.includes("files.download"),
      );
      if (epoch === copyEpoch.current && currentServices.current === services) {
        cutClipboard.syncSystem(sequence);
        setSystemCopyNotice(
          ["file", "directory"].includes(entry.kind) &&
            session?.info.capabilities.includes("files.download")
            ? "Pasting in Explorer copies the item and keeps its remote source"
            : "Ready to move within this workspace",
        );
      }
    } catch (error) {
      if (epoch === copyEpoch.current && currentServices.current === services) {
        setError(String(error));
        setSystemCopyNotice("");
      }
    } finally {
      if (currentServices.current === services) {
        setPicking(false);
        preparationRef.current = null;
        setPreparingClipboard(false);
      }
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
          (item) =>
            transferable(item.entry) &&
            item.parent !== parent &&
            item.entry.path !== parent,
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
        (canUpload ||
          canMove ||
          (connected && !!session?.info.capabilities.includes("files.copy"))) &&
        !!parent &&
        !loading &&
        !busy &&
        !transferBusy &&
        !cutState.working)
    );
  }
  async function pasteMove(parent: string, sequence?: number) {
    // Hand busy ownership from clipboard inspection to the move itself. Keeping
    // `picking` charged here makes our own location watcher refuse relocation.
    setPicking(false);
    transferState.current = transfers.some(pendingTransfer);
    return sequence === undefined
      ? cutClipboard.paste(parent)
      : cutClipboard.pasteSystem(parent, sequence);
  }
  async function pasteInto(parent: string) {
    if (!canPasteInto(parent)) return;
    setError("");
    setPicking(true);
    try {
      if (services.systemFileClipboard) {
        const snapshot = await services.inspectSystemFiles?.();
        const sequence =
          snapshot?.sequence ?? (await services.systemClipboardSequence());
        if (sequence !== cutClipboard.snapshot().systemSequence) {
          cutClipboard.clear();
          setSystemCopyNotice("");
          if (snapshot?.kind === "empty")
            throw new Error(
              "The file clipboard is empty. Copy or cut an item first.",
            );
          if (snapshot?.kind === "remote") {
            if (snapshot.intent === "move") {
              if (
                !session?.info.capabilities.includes("files.move") ||
                !services.pasteMovedFiles
              )
                throw new Error(
                  "This host does not support moving the cut item.",
                );
              // Run directly: a queued transfer would mark this view busy and
              // prevent the shared relocation guard from following its paths.
              await pasteMove(parent, sequence);
              return;
            }
            if (
              !session?.info.capabilities.includes("files.copy") ||
              !services.pasteCopiedFiles
            )
              throw new Error(
                "This host does not support copying the remote clipboard selection.",
              );
            queue.enqueue(await services.pasteCopiedFiles(parent, sequence));
            return;
          }
          if (!session?.info.capabilities.includes("files.upload"))
            throw new Error(
              "This host does not support uploading clipboard files.",
            );
          const tickets = await services.pasteSystemFiles(
            parent,
            snapshot?.sequence,
          );
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
      else await pasteMove(parent);
    } catch (error) {
      if (
        currentServices.current === services &&
        !cutClipboard.snapshot().error
      )
        setError(String(error));
    } finally {
      if (currentServices.current === services) {
        setPicking(false);
        preparationRef.current = null;
        setPreparingClipboard(false);
      }
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
    directoryScan.current?.abort();
    const scan = new AbortController();
    directoryScan.current = scan;
    const current = ++request.current;
    ++previewRequest.current;
    previewPending.current = false;
    setLoading(true);
    setScanReady(false);
    setError("");
    if (!options.preservePreview) {
      view.current.document = null;
      setDocument(null);
    }
    const previous = view.current;
    let first = true;
    try {
      await scanDirectory(
        services,
        path === "" ? undefined : path,
        scan.signal,
        (result, done) => {
          if (current !== request.current || scan.signal.aborted) return;
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
          // Keep selections that may occur on later pages until discovery completes.
          const selectedNow = first
            ? preserveSelection
              ? previous.selected
              : null
            : view.current.selected;
          const selectionNow = first
            ? preserveSelection
              ? previous.selection
              : []
            : view.current.selection;
          const discovered = done
            ? new Set(result.entries.map((entry) => entry.path))
            : null;
          const nextSelected =
            discovered && selectedNow && !discovered.has(selectedNow)
              ? null
              : selectedNow;
          const nextSelection = discovered
            ? selectionNow.filter((path) => discovered.has(path))
            : selectionNow;
          view.current = {
            ...view.current,
            directory: result,
            history: nextHistory,
            pathInput: first ? nextInput : view.current.pathInput,
            selected: nextSelected,
            selection: nextSelection,
          };
          if (first) {
            setScanReady(true);
            setHistory(nextHistory);
            setPathInput(nextInput);
            if (!options.background) selectionAnchor.current = null;
          }
          setDirectory(result);
          setSelected(nextSelected);
          setSelection(nextSelection);
          first = false;
        },
      );
    } catch (e) {
      if (current === request.current && !scan.signal.aborted)
        setError(String(e));
    } finally {
      if (current === request.current) setLoading(false);
      if (directoryScan.current === scan) directoryScan.current = null;
    }
  }
  useLayoutEffect(() => {
    const changed = previousSource.current !== sourceKey;
    previousSource.current = sourceKey;
    if (changed) {
      const empty = {
        path: "",
        name: "Files",
        parent: null,
        home: null,
        roots: [],
        entries: [],
      };
      view.current = {
        ...view.current,
        directory: empty,
        pathInput: "",
        history: [],
        selected: null,
        selection: [],
        document: null,
      };
      setDirectory(empty);
      setPathInput("");
      setHistory([]);
      setSelected(null);
      setSelection([]);
      selectionAnchor.current = null;
      setDocument(null);
      setMoveTarget(null);
      setDeleteTarget(null);
      setOperation(null);
      closeMenu();
      setBusy(false);
      relocatingRef.current = false;
    }
    initialLocation.current = changed
      ? undefined
      : directory.path || launch?.path;
    if (!connected) setLoading(false);
    return () => {
      directoryScan.current?.abort();
      ++request.current;
      ++previewRequest.current;
    };
  }, [session?.id, sourceKey, connected]);
  // Parent layout effects commit/reactivate the accepted workspace bindings.
  // Reset stale UI above before paint, but start I/O only after that commit.
  useEffect(() => {
    if (connected) void navigate(initialLocation.current, false);
  }, [session?.id, sourceKey, connected]);
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
  const rows = useVirtualRows(entries.length);
  const selectedPaths = useMemo(() => new Set(selection), [selection]);
  const selectedEntries = entries.filter((entry) =>
    selectedPaths.has(entry.path),
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
          label: `Copy ${selectedEntries.length} ${selectedEntries.some((item) => item.kind === "directory") ? "items" : "files"}`,
          shortcut: "Ctrl+C",
          disabled:
            !copyAvailable ||
            selectedEntries.some(
              (entry) => !transferable(entry) || !entry.revision,
            ),
          run: copySelection,
        },
        {
          id: "download-files",
          label: "Download files…",
          disabled:
            !canDownload ||
            selectedEntries.some(
              (entry) => !transferable(entry) || !entry.revision,
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
      {
        id: "upload-folder",
        label: "Upload folder…",
        disabled:
          !canUpload || !session?.info.capabilities.includes("files.folders"),
        run: () => void upload(true),
      },
      ...(entry
        ? [
            {
              id: "download",
              label: "Download…",
              disabled: !canDownload || !transferable(entry) || !entry.revision,
              run: () => void download(entry),
            },
            {
              id: "copy-clipboard",
              label: "Copy",
              shortcut: "Ctrl+C",
              disabled:
                !copyAvailable || !transferable(entry) || !entry.revision,
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
                !transferable(entry) ||
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
              disabled:
                !connected ||
                !session ||
                !!capabilityOperationReason(session, "files.read", "readText"),
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
        disabled: !connected || !history.length || relocating,
        run: back,
      },
      {
        id: "parent",
        label: "Parent folder",
        shortcut: "Alt+↑",
        disabled: !connected || relocating || directory.parent === null,
        run: parent,
      },
      {
        id: "refresh",
        label: "Refresh",
        shortcut: "F5",
        disabled: !connected || relocating,
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
        if (event.key === "Escape" && preparationRef.current) {
          event.preventDefault();
          void cancelClipboardPreparation();
          return;
        }
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
          if (!relocating) void navigate(directory.path, false);
        } else if (event.altKey && event.key === "ArrowLeft") {
          event.preventDefault();
          back();
        } else if (event.altKey && event.key === "ArrowUp") {
          event.preventDefault();
          if (!relocating) parent();
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
              selectedEntries.some(
                (entry) => !transferable(entry) || !entry.revision,
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
            disabled={!connected || !history.length || relocating}
            onClick={back}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            className="icon-button"
            title="Parent folder"
            aria-label="Parent folder"
            disabled={!connected || relocating || directory.parent === null}
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
            disabled={!connected || relocating}
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
        {(cutState.item ||
          cutState.copies?.length ||
          cutState.working ||
          cutState.cleanupPending) && (
          <div className="file-cut-bar" role="status">
            {cutState.working || preparingClipboard ? (
              <LoaderCircle size={15} className="spin" />
            ) : cutState.copies?.length ? (
              <Copy size={15} />
            ) : (
              <Scissors size={15} />
            )}
            <div className="file-cut-description">
              <strong>
                {cutState.cleanupPending
                  ? cutState.working
                    ? "Releasing clipboard…"
                    : "Clipboard cleanup required"
                  : preparingClipboard
                    ? "Preparing clipboard…"
                    : cutState.working
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
            {preparingClipboard && (
              <button onClick={() => void cancelClipboardPreparation()}>
                Cancel preparation
              </button>
            )}
            <button
              disabled={
                cutState.cleanupPending || !canPasteInto(directory.path)
              }
              onClick={() => void pasteInto(directory.path)}
            >
              <ClipboardPaste size={14} /> Paste here
            </button>
            <button
              className={cutState.cleanupPending ? undefined : "icon-button"}
              aria-label={
                cutState.cleanupPending
                  ? "Retry clipboard cleanup"
                  : cutState.copies?.length
                    ? "Clear copied files"
                    : "Cancel cut"
              }
              title={
                cutState.cleanupPending
                  ? "Retry releasing the clipboard reservation"
                  : "Clear file clipboard · Esc"
              }
              disabled={cutState.working || preparingClipboard}
              onClick={() => cutClipboard.clear()}
            >
              {cutState.cleanupPending ? "Retry cleanup" : <X size={15} />}
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
            ref={rows.attach}
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
            {relocating || (reading && (!scanReady || !entries.length)) ? (
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
              <>
                <div aria-hidden="true" style={{ height: rows.before }} />
                {entries.slice(rows.start, rows.end).map((entry, rowOffset) => {
                  const Icon =
                    entry.kind === "directory"
                      ? Folder
                      : /\.(yaml|json|toml|sh)$/.test(entry.name)
                        ? FileCode2
                        : FileText;
                  return (
                    <button
                      className={`file-row ${selectedPaths.has(entry.path) ? "active" : ""} ${cutState.item?.entry.path === entry.path ? "cut-entry" : ""}`}
                      data-virtual-index={rows.start + rowOffset}
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
                        const index = rows.start + rowOffset;
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
                          rows.focus(next);
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
                })}
                <div aria-hidden="true" style={{ height: rows.after }} />
              </>
            )}
          </div>
        )}
        {transfers.length > 0 && (
          <TransferPanel rows={transfers} queue={queue} />
        )}
        <footer className="files-footer">
          <span aria-live="polite">
            {entries.length} items
            {reading ? " · discovering…" : ""}
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
