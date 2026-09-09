// SPDX-License-Identifier: MPL-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "../../src/App";
import { apps } from "../../src/apps/registry";
import {
  AppCatalog,
  indexedCatalogStorage,
} from "../../src/extensions/catalog";
import { DesktopRuntime } from "../../src/extensions/desktop-runtime";
import { indexedAppStorage } from "../../src/extensions/app-storage";
import { storageProbe } from "./storage-probe";
import type {
  AppEnvironment,
  ServiceMethodInfo,
} from "../../src/extensions/environment-api";
import { previewServices, previewSession } from "../../src/preview";
import type {
  Session,
  FileEntry,
  TransferTicket,
  TransferOutcome,
  TransferProgress,
  HostSetting,
} from "../../src/sdk";
import source from "../../.local/native-extension-probe/desktop-client.js?raw";
import style from "../../examples/dialog-app/style.css?raw";
import "../../src/styles.css";
const catalog = new AppCatalog(
  indexedCatalogStorage("shellcanvas-native-desktop-probe"),
);
const localData = indexedAppStorage("shellcanvas-desktop-probe-data");
let clipboardText = "Fixture clipboard";
let clipboardReads = 0;
const runtime = new DesktopRuntime(catalog, apps, localData, {
  readText: async () => {
    clipboardReads++;
    return clipboardText;
  },
  writeText: async (text) => {
    clipboardText = text;
  },
});
let sessionSerial = 100;
const fixtureSession: Session = {
  ...previewSession,
  info: {
    ...previewSession.info,
    capabilities: [
      ...previewSession.info.capabilities,
      "files.edit",
      "files.create",
      "files.manage",
      "files.move",
      "files.copy",
      "files.upload",
      "files.download",
      "files.folders",
      "host.settings",
    ],
  },
};
let fileWrites = 0;
let setting: HostSetting = {
  id: "fixture:mode",
  label: "Device mode",
  description: "Fixture device setting",
  value: "normal",
  revision: "h1",
  editor: "select",
  choices: ["normal", "quiet", "held"],
  writable: true,
  reason: null,
};
let settingAttempts = 0;
let settingWrites = 0;
let heldSetting: (() => void) | undefined;
let remoteText = "Original note";
let remoteRevision = 1;
let fileActions = 0;
let transferSerial = 0;
let transferRuns = 0;
let transferCancellations = 0;
let heldTransfer: ((outcome: TransferOutcome) => void) | undefined;
let heldChooser: ((tickets: TransferTicket[]) => void) | undefined;
let failTransferCleanup = false;
const transferTickets = new Map<number, TransferTicket>();
function transferTicket(direction: TransferTicket["direction"]) {
  const ticket = {
    id: ++transferSerial,
    name: "fixture.dat",
    size: 100,
    direction,
  };
  transferTickets.set(ticket.id, ticket);
  return ticket;
}
const actionEntries = new Map<string, FileEntry & { parent: string }>([
  [
    "fixture:entry",
    {
      path: "fixture:entry",
      parent: "fixture:actions",
      name: "original.txt",
      kind: "file",
      revision: "entry-1",
      size: 4,
      modified: null,
    },
  ],
]);
const actionEntry = (path: string, revision: string) => {
  const entry = actionEntries.get(path);
  if (!entry || entry.revision !== revision)
    throw new Error("Entry revision changed");
  return entry;
};
const relocateAction = (
  path: string,
  parent: string,
  name: string,
  revision: string,
  nextPath: string,
  nextRevision: string,
) => {
  const entry = actionEntry(path, revision);
  actionEntries.delete(path);
  actionEntries.set(nextPath, {
    ...entry,
    parent,
    path: nextPath,
    name,
    revision: nextRevision,
  });
  fileActions++;
  return {
    path: nextPath,
    locations: [{ previous: path, location: { path: nextPath, parent, name } }],
  };
};
const services = {
  ...previewServices,
  readHostSettings: async () => [
    { ...setting },
    {
      ...setting,
      id: "fixture:readonly",
      writable: false,
      value: null,
      revision: null,
      reason: "Unsupported on this device",
    },
  ],
  applyHostSetting: async (
    _id: number,
    id: string,
    value: string,
    revision: string,
  ) => {
    settingAttempts++;
    if (
      id !== setting.id ||
      revision !== setting.revision ||
      !setting.choices.includes(value)
    )
      throw new Error("Setting revision changed or invalid value");
    if (value === "held")
      await new Promise<void>((resolve) => {
        heldSetting = resolve;
      });
    settingWrites++;
    setting = { ...setting, value, revision: `h${settingWrites + 1}` };
    return { ...setting };
  },
  prepareCopy: async (
    _id: number,
    path: string,
    revision: string,
    parent: string,
  ) => {
    if (
      path !== "fixture:transfer" ||
      revision !== "transfer-1" ||
      parent !== "fixture:destination"
    )
      throw new Error("Incorrect transfer source or destination");
    return transferTicket("copy");
  },
  chooseUploads: async (_id: number, parent: string, folder?: boolean) => {
    if (parent === "fixture:late-chooser")
      return new Promise<TransferTicket[]>((resolve) => {
        heldChooser = resolve;
      });
    if (parent !== "fixture:destination" || folder !== true)
      throw new Error("Expected folder chooser");
    return [transferTicket("upload")];
  },
  chooseDownload: async (_id: number, path: string, revision: string) => {
    if (path !== "fixture:transfer" || revision !== "transfer-1")
      throw new Error("Incorrect download entry");
    return transferTicket("download");
  },
  chooseDownloads: async (
    _id: number,
    entries: { path: string; revision: string }[],
  ) => {
    if (
      entries.length !== 2 ||
      entries.some((entry) => entry.revision !== "transfer-1")
    )
      throw new Error("Incorrect download batch");
    return entries.map(() => transferTicket("download"));
  },
  runTransfer: async (
    _session: number,
    id: number,
    onProgress: (event: TransferProgress) => void,
  ): Promise<TransferOutcome> => {
    const ticket = transferTickets.get(id);
    if (!ticket) throw new Error("Transfer ticket not owned");
    transferRuns++;
    onProgress({ bytes: 60, total: 100, phase: "running" });
    try {
      return ticket.direction === "copy"
        ? await new Promise<TransferOutcome>((resolve) => {
            heldTransfer = resolve;
          })
        : {
            status: "completed",
            bytes: 100,
            total: 100,
            path:
              ticket.direction === "download"
                ? "C:\\fixture\\private-local-path"
                : "fixture:uploaded",
          };
    } finally {
      transferTickets.delete(id);
    }
  },
  cancelTransfer: async (_session: number, id: number) => {
    if (!transferTickets.has(id)) throw new Error("Unknown cancellation");
    if (failTransferCleanup)
      throw new Error("Fixture cleanup temporarily unavailable");
    transferCancellations++;
    // Acknowledging a running cancellation does not undo completed publication.
    transferTickets.delete(id);
  },
  makeDirectory: async (_id: number, parent: string, name: string) => {
    if (actionEntries.has("fixture:folder"))
      throw new Error("Destination already exists");
    actionEntries.set("fixture:folder", {
      path: "fixture:folder",
      parent,
      name,
      revision: "folder-1",
      kind: "directory",
      size: 0,
      modified: null,
    });
    fileActions++;
    return "fixture:folder";
  },
  renameEntry: async (
    _id: number,
    path: string,
    name: string,
    revision: string,
  ) =>
    relocateAction(
      path,
      actionEntry(path, revision).parent,
      name,
      revision,
      "fixture:renamed",
      "entry-2",
    ),
  moveEntry: async (
    _id: number,
    path: string,
    parent: string,
    revision: string,
  ) => {
    if (parent !== "fixture:folder") throw new Error("Wrong destination");
    return relocateAction(
      path,
      parent,
      actionEntry(path, revision).name,
      revision,
      "fixture:moved",
      "entry-3",
    );
  },
  removeEntry: async (_id: number, path: string, revision: string) => {
    actionEntry(path, revision);
    if ([...actionEntries.values()].some((entry) => entry.parent === path))
      throw new Error("Directory is not empty");
    actionEntries.delete(path);
    fileActions++;
  },
  list: async (id: number, path?: string) =>
    path === "fixture:actions" || path === "fixture:folder"
      ? {
          path,
          name: "File actions",
          parent: null,
          home: null,
          roots: [{ path: "fixture:actions", name: "Actions" }],
          entries: [...actionEntries.values()].filter(
            (entry) => entry.parent === path,
          ),
        }
      : path === "fixture:many"
        ? {
            path,
            name: "Many entries",
            parent: "fixture:root",
            home: null,
            roots: [{ path: "fixture:root", name: "Root" }],
            entries: Array.from({ length: 257 }, (_, index) => ({
              path: `fixture:item:${index}`,
              name: `item-${index}`,
              kind: "file" as const,
              size: index,
              modified: null,
            })),
          }
        : previewServices.list(id, path),
  connect: async () => ({ ...fixtureSession, id: ++sessionSerial }),
  readText: async (_id: number, path: string) => ({
    path,
    parent: "fixture:root",
    name: "note.txt",
    text: remoteText,
    revision: String(remoteRevision),
    writable: true,
  }),
  saveText: async (
    _id: number,
    path: string,
    text: string,
    revision: string,
  ) => {
    if (revision !== String(remoteRevision))
      throw new Error("Revision conflict");
    fileWrites++;
    remoteText = text;
    remoteRevision++;
    return {
      path,
      parent: "fixture:root",
      name: "note.txt",
      text,
      revision: String(remoteRevision),
      writable: true,
    };
  },
  createText: async (
    _id: number,
    parent: string,
    name: string,
    text: string,
  ) => ({
    path: "fixture:new",
    parent,
    name,
    text,
    revision: "new",
    writable: true,
  }),
};
const checks: Record<string, boolean> = {};
const report = async (stage: string) => {
  if (isTauri()) await emit("shellcanvas-native-extension-progress", { stage });
};
async function until<T>(read: () => T, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}
function button(text: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text && !item.disabled,
  )!;
}
function ask(frame: HTMLIFrameElement, action = "snapshot") {
  const request = crypto.randomUUID();
  return new Promise<{
    text: string;
    status: string;
    ready: boolean;
    openNoteEnabled: boolean;
    storage?: Record<string, unknown>;
    files?: Record<string, boolean>;
    transfers?: Record<string, boolean>;
    hostSettings?: Record<string, boolean>;
    windowState?: import("@shellcanvas/app-sdk").AppWindowState;
    windowError?: string;
    environment?: AppEnvironment;
    services?: readonly ServiceMethodInfo[];
    environmentEvents?: AppEnvironment[];
    clipboard?: Record<string, boolean>;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Frame did not answer"));
    }, 3000);
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.contentWindow ||
        event.data?.type !== "desktop-probe-result" ||
        event.data.request !== request
      )
        return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolve(event.data);
    };
    window.addEventListener("message", receive);
    frame.contentWindow!.postMessage(
      { type: "desktop-probe", request, action },
      "*",
    );
  });
}
async function frameState(
  frame: HTMLIFrameElement,
  check: (state: Awaited<ReturnType<typeof ask>>) => boolean,
) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try {
      const state = await ask(frame);
      if (check(state)) return state;
    } catch {
      /* Document may still be loading. */
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Frame did not reach the expected state");
}
async function install(version: string) {
  const input = await until(
    () =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Select app package"]',
      ),
    "package input",
  );
  const data = new DataTransfer();
  data.items.add(
    new File(
      [
        JSON.stringify({
          format: 1,
          kind: "app",
          id: "org.shellcanvas.native-fixture",
          title: "Native Notes",
          version,
          permissions: [
            "system.dialogs",
            "files.read",
            "files.edit",
            "files.create",
            "host.settings.read",
            ...(version === "1.0.0"
              ? [
                  "files.manage",
                  "files.move",
                  "files.copy",
                  "files.upload",
                  "files.download",
                  "host.settings.write",
                ]
              : []),
            "system.storage",
            "system.clipboard.read",
            "system.clipboard.write",
          ],
          script: source,
          style,
        }),
      ],
      "fixture.shellcanvas.json",
      { type: "application/json" },
    ),
  );
  input.files = data.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const installButton = await until(
    () => button(version === "1.0.0" ? "Install app" : "Install update"),
    "installation review",
  );
  if (version === "2.0.0") {
    const checkbox = [
      ...document.querySelectorAll<HTMLInputElement>(
        '.extension-review input[type="checkbox"]',
      ),
    ].find((item) =>
      item.closest("label")?.textContent?.includes("File browsing"),
    )!;
    checkbox.click();
    [
      ...document.querySelectorAll<HTMLInputElement>(
        '.extension-review input[type="checkbox"]',
      ),
    ]
      .find((item) =>
        item.closest("label")?.textContent?.includes("Read clipboard text"),
      )!
      .click();
  }
  installButton.click();
  await until(
    () => catalog.snapshot().some((entry) => entry.package.version === version),
    "committed install",
  );
  await report(`installed-${version}`);
}
async function run() {
  const persistence = !isTauri()
    ? new URL(location.href).searchParams.get("persistence")
    : null;
  Object.assign(checks, await storageProbe());
  for (const bucket of ["data", "settings"] as const) {
    const signal = new AbortController().signal;
    const previous = await localData.get(
      "org.shellcanvas.native-fixture",
      bucket,
      "sdk-note",
      signal,
    );
    if (previous)
      await localData.remove(
        "org.shellcanvas.native-fixture",
        bucket,
        "sdk-note",
        previous.revision,
        signal,
      );
  }
  await catalog.load();
  for (const entry of catalog.snapshot())
    await catalog.remove(entry.package.id, entry.generation);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App
        services={services}
        initialSession={fixtureSession}
        isNative={true}
        appRuntime={runtime}
        initialConnection={{
          name: "Fixture",
          host: "fixture.invalid",
          port: 22,
          username: "fixture",
          keyPath: "fixture-key",
        }}
      />
    </StrictMode>,
  );
  (
    await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Open Apps"]',
        ),
      "Apps dock button",
    )
  ).click();
  await install("1.0.0");
  (await until(() => button("Open app"), "open installed app")).click();
  const first = await until(
    () =>
      document.querySelector<HTMLIFrameElement>('iframe[title="Native Notes"]'),
    "first runtime window",
  );
  await until(
    () => first.getAttribute(isTauri() ? "src" : "srcdoc"),
    "frame document",
  );
  await frameState(first, (state) => state.ready);
  const initialEnvironment = await ask(first, "watch");
  checks.discovery =
    initialEnvironment.services?.some(
      (method) =>
        method.name === "system.dialogs.openFile" &&
        method.granted &&
        method.available,
    ) === true &&
    !initialEnvironment.services.some((method) =>
      method.name.includes("publish_app_frame"),
    );
  await frameState(
    first,
    (state) =>
      state.environmentEvents?.some(
        (event) => event.connection === "connected",
      ) === true,
  );
  first
    .closest(".app-window")!
    .querySelector<HTMLButtonElement>('button[aria-label^="Minimize "]')!
    .click();
  await frameState(
    first,
    (state) => state.environmentEvents?.at(-1)?.visible === false,
  );
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Open Native Notes"]')!
    .click();
  await frameState(
    first,
    (state) => state.environmentEvents?.at(-1)?.visible === true,
  );
  checks.visibilityEvents = true;
  checks.windowDiscovery = [
    "getState",
    "focus",
    "minimize",
    "maximize",
    "restore",
    "requestClose",
  ].every((action) =>
    initialEnvironment.services?.some(
      (method) =>
        method.name === `system.window.${action}` &&
        method.available &&
        method.granted &&
        method.permissions.length === 0,
    ),
  );
  await ask(first, "window-minimize");
  await until(
    () => first.closest(".app-window")!.classList.contains("hidden-window"),
    "SDK minimize",
  );
  checks.windowMinimize =
    (await ask(first, "window-state")).windowState?.visible === false;
  await ask(first, "window-focus");
  await until(
    () => !first.closest(".app-window")!.classList.contains("hidden-window"),
    "SDK focus restores",
  );
  checks.windowFocus =
    (await ask(first, "window-state")).windowState?.focused === true;
  await ask(first, "window-maximize");
  await until(
    () => first.closest(".app-window")!.classList.contains("maximized"),
    "SDK maximize",
  );
  checks.windowMaximize =
    (await ask(first, "window-state")).windowState?.mode === "maximized";
  await ask(first, "window-restore");
  await until(
    () => !first.closest(".app-window")!.classList.contains("maximized"),
    "SDK restore",
  );
  checks.windowRestore =
    (await ask(first, "window-state")).windowState?.mode === "normal";
  const preparedTransfer = (await ask(first, "transfer-prepare")).transfers;
  checks.sdkTransferPreparation =
    !!preparedTransfer &&
    Object.values(preparedTransfer).every(Boolean) &&
    transferRuns === 0;
  const closeTransferWindow = () =>
    first
      .closest(".app-window")!
      .querySelector<HTMLButtonElement>('button[aria-label^="Close "]')!;
  await until(
    () => closeTransferWindow().disabled,
    "prepared transfer close guard",
  );
  checks.sdkTransferBusyGuard =
    closeTransferWindow().disabled &&
    !first.closest(".app-window")!.querySelector(".unsaved-dot");
  checks.windowTransferCloseGuard =
    (await ask(first, "window-close")).windowError === "busy" &&
    first.isConnected;
  if (isTauri()) {
    await getCurrentWindow().close();
    await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          'dialog[aria-label="An operation is still running"] .danger-button',
        )?.disabled,
      "transfer quit guard",
    );
    checks.sdkTransferQuitGuard = true;
    (
      await until(() => button("Keep working"), "keep transfer running")
    ).click();
  }
  await ask(first, "transfer-run");
  await until(() => heldTransfer, "transfer backend started");
  const canceledTransfer = (await ask(first, "transfer-cancel")).transfers;
  checks.sdkTransferCancelWait =
    canceledTransfer?.waiting === true &&
    transferCancellations === 1 &&
    closeTransferWindow().disabled;
  heldTransfer!({
    status: "completed",
    bytes: 100,
    total: 100,
    path: "fixture:copied",
  });
  const finishedTransfer = (await ask(first, "transfer-finish")).transfers;
  await until(() => !closeTransferWindow().disabled, "transfer guard released");
  checks.sdkTransferLateCompletion =
    !!finishedTransfer &&
    Object.values(finishedTransfer).every(Boolean) &&
    transferRuns === 1;
  const transferRoundtrip = (await ask(first, "transfer-roundtrip")).transfers;
  checks.sdkTransferChoosers =
    !!transferRoundtrip &&
    Object.values(transferRoundtrip).every(Boolean) &&
    transferRuns === 5 &&
    transferTickets.size === 0;
  await ask(first, "transfer-late-prepare");
  await until(() => heldChooser, "late chooser opened");
  const lateCanceled = (await ask(first, "transfer-late-cancel")).transfers;
  failTransferCleanup = true;
  heldChooser!([transferTicket("upload")]);
  const retryCleanup = await until(
    () => button("Retry transfer cleanup"),
    "orphan transfer cleanup recovery",
  );
  checks.sdkTransferCleanupFailure =
    lateCanceled?.aborted === true &&
    closeTransferWindow().disabled &&
    transferRuns === 5;
  failTransferCleanup = false;
  retryCleanup.click();
  await until(
    () => !closeTransferWindow().disabled && !button("Retry transfer cleanup"),
    "orphan cleanup released",
  );
  checks.sdkTransferCleanupRetry =
    transferTickets.size === 0 && transferRuns === 5;
  await report("sdk-transfers");
  const settingResult = (await ask(first, "host-settings")).hostSettings;
  checks.sdkHostSettings =
    !!settingResult &&
    Object.values(settingResult).every(Boolean) &&
    settingWrites === 1 &&
    settingAttempts === 2;
  await ask(first, "host-settings-start");
  await until(
    () => heldSetting && closeTransferWindow().disabled,
    "settings write close guard",
  );
  if (isTauri()) {
    await getCurrentWindow().close();
    await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          'dialog[aria-label="An operation is still running"] .danger-button',
        )?.disabled,
      "settings quit guard",
    );
    checks.sdkSettingsQuitGuard = true;
    button("Keep working").click();
  }
  const settingsCanceled = (await ask(first, "host-settings-cancel"))
    .hostSettings;
  checks.sdkSettingsCancelGuard =
    settingsCanceled?.aborted === true &&
    closeTransferWindow().disabled &&
    settingWrites === 1;
  await ask(first, "transfer-prepare");
  heldSetting!();
  await until(() => settingWrites === 2, "settings backend settled");
  checks.sdkIndependentBusyOwners = closeTransferWindow().disabled;
  await ask(first, "transfer-release");
  await until(() => !closeTransferWindow().disabled, "settings write settled");
  checks.sdkSettingsRefreshAfterCancel =
    (await ask(first, "host-settings-refresh")).hostSettings?.updated ===
      true &&
    settingWrites === 2 &&
    settingAttempts === 3;
  await report("sdk-host-settings");
  if (persistence === "read") {
    await ask(first, "restore");
    checks.storageSurvivesPageClose =
      (
        await frameState(
          first,
          (state) => state.ready && state.status.includes("Restored the note"),
        )
      ).text === "A draft kept across package updates.";
  }
  await ask(first, "edit");
  await until(
    () => first.closest(".app-window")?.querySelector(".unsaved-dot"),
    "dirty window state",
  );
  checks.sdkDocumentState = true;
  const fileResult = (await ask(first, "files")).files;
  checks.sdkRemoteText =
    !!fileResult &&
    Object.values(fileResult).every(Boolean) &&
    fileWrites === 1;
  checks.sdkFileActions =
    fileResult?.actions === true &&
    fileActions === 5 &&
    actionEntries.size === 0;
  const clipboard = (await ask(first, "clipboard")).clipboard;
  checks.sdkClipboard = !!clipboard && Object.values(clipboard).every(Boolean);
  const appStorage = (await ask(first, "storage")).storage;
  checks.sdkStorage =
    !!appStorage &&
    !appStorage.error &&
    Object.values(appStorage).every((value) => value === true);
  await ask(first, "remember");
  await frameState(
    first,
    (state) =>
      state.ready && state.status.includes("Remembered on this device"),
  );
  if (persistence === "write") {
    document.body.dataset.probeResult = JSON.stringify({
      success: Object.values(checks).every(Boolean),
      phase: "remembered-for-page-close",
      checks,
    });
    return;
  }
  if (isTauri()) {
    await getCurrentWindow().close();
    (await until(() => button("Keep working"), "native quit review")).click();
    checks.nativeQuitKeepsDraft =
      (await ask(first)).text === "A draft kept across package updates.";
  }
  await ask(first, "message");
  (await until(() => button("Looks good"), "shared message box")).click();
  await until(
    () => !document.querySelector("dialog[open]"),
    "message box closed",
  );
  checks.sharedDialog =
    (await frameState(first, (state) => state.status === '"ok"')).status ===
    '"ok"';
  button("Disconnect").click();
  (await until(() => button("Reconnect host"), "reconnect action")).click();
  (
    await until(() => button("Reconnect workspace"), "reconnect dialog")
  ).click();
  const acceptConnection = await until(
    () => button("Use reconnected host"),
    "explicit connection switch",
  );
  checks.reconnectPreservesDraft =
    (await ask(first)).text === "A draft kept across package updates.";
  const reviewEnvironment = await ask(first, "environment");
  checks.discoveryRetired =
    reviewEnvironment.environment?.connection === "review-required" &&
    reviewEnvironment.services?.find(
      (method) => method.name === "system.dialogs.openFile",
    )?.available === false;
  await frameState(first, (state) => state.ready && !state.openNoteEnabled);
  checks.exampleDisablesUnavailableText = true;
  await frameState(
    first,
    (state) =>
      state.environmentEvents?.some(
        (event) => event.connection === "disconnected",
      ) === true &&
      state.environmentEvents.some(
        (event) => event.connection === "review-required",
      ),
  );
  checks.connectionEvents = true;
  await ask(first, "browse");
  await frameState(
    first,
    (state) => state.ready && state.status.includes("currently unavailable"),
  );
  checks.oldConnectionRetired = !document.querySelector("dialog[open]");
  acceptConnection.click();
  await ask(first, "browse");
  const fileDialog = await until(
    () =>
      document.querySelector<HTMLDialogElement>(
        'dialog[open][aria-label="Browse this workspace"]',
      ),
    "rebound file dialog",
  );
  checks.explicitReconnectWorks = true;
  const acceptedEnvironment = await ask(first, "environment");
  checks.explicitBindingGeneration =
    acceptedEnvironment.environment?.connection === "connected" &&
    acceptedEnvironment.environment.binding !==
      initialEnvironment.environment?.binding;
  button("Cancel", fileDialog).click();
  const staleFiles = (await ask(first, "files-stale")).files;
  checks.sdkOldSettingRejected =
    (await ask(first, "host-settings-stale")).hostSettings?.rejected === true &&
    settingAttempts === 3;
  await frameState(first, (state) => state.ready && state.openNoteEnabled);
  checks.exampleRestoresTextAction = true;
  checks.sdkOldDocumentRejected =
    staleFiles?.rejected === true && fileWrites === 1;
  checks.sdkOldListingRejected = staleFiles?.listingRejected === true;
  checks.sdkOldActionRejected =
    staleFiles?.actionRejected === true && fileActions === 5;
  await frameState(first, (state) => state.ready);
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Open Apps"]')!
    .click();
  await install("2.0.0");
  (await until(() => button("Open app"), "open updated app")).click();
  const second = await until(
    () =>
      [
        ...document.querySelectorAll<HTMLIFrameElement>(
          'iframe[title="Native Notes"]',
        ),
      ].find((frame) => frame !== first),
    "second runtime window",
  );
  await frameState(second, (state) => state.ready);
  const readOnlySettings = (await ask(second, "host-settings-readonly"))
    .hostSettings;
  checks.sdkSettingsReadOnlyGrant =
    readOnlySettings?.read === true &&
    readOnlySettings.denied === true &&
    settingAttempts === 3;
  checks.sdkTransferGrantDenied =
    (await ask(second, "transfer-denied")).transfers?.denied === true &&
    transferRuns === 5;
  const secondEnvironment = await ask(second, "environment");
  const deniedFiles = (await ask(second, "files-denied")).files;
  checks.sdkFileGrantDenied = deniedFiles?.rejected === true;
  checks.sdkListingGrantDenied = deniedFiles?.listingRejected === true;
  checks.sdkActionGrantDenied =
    deniedFiles?.actionRejected === true && fileActions === 5;
  const beforeDeniedRead = clipboardReads;
  checks.clipboardGrantDenied =
    (await ask(second, "clipboard-denied")).clipboard?.denied === true &&
    clipboardReads === beforeDeniedRead;
  checks.discoveryGrantDenied =
    secondEnvironment.services?.find(
      (method) => method.name === "system.dialogs.openFile",
    )?.granted === false;
  await ask(second, "restore");
  checks.storageSurvivesUpdate =
    (
      await frameState(
        second,
        (state) => state.ready && state.status.includes("Restored the note"),
      )
    ).text === "A draft kept across package updates.";
  checks.twoVersions =
    document.body.textContent!.includes("Version 1.0.0") &&
    document.body.textContent!.includes("Version 2.0.0");
  // Keep this exact native-tested scene available for a manual browser layout/focus review.
  if (!isTauri() && new URL(location.href).searchParams.has("inspect")) return;
  for (const frame of [first, second, first])
    frame
      .closest(".app-window")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  checks.draftPreserved =
    (await ask(first)).text === "A draft kept across package updates.";
  await ask(second, "browse");
  checks.updatedGrantDenied = (
    await frameState(second, (state) =>
      state.status.includes("required permission"),
    )
  ).status.includes("required permission");
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Open Apps"]')!
    .click();
  button("Disable").click();
  await until(() => catalog.snapshot()[0]?.enabled === false, "disabled");
  checks.disabledKeepsDraft =
    (await ask(first)).text === "A draft kept across package updates.";
  button("Remove").click();
  await until(
    () =>
      document
        .querySelector(".extension-error")
        ?.textContent?.includes("running windows"),
    "removal refused",
  );
  checks.removeRefused = true;
  await ask(first, "window-close");
  (await until(() => button("Keep working"), "dirty close review")).click();
  checks.keepWorking =
    (await ask(first)).text === "A draft kept across package updates.";
  checks.windowDirtyCloseGuard = checks.keepWorking;
  first
    .closest(".app-window")!
    .querySelector<HTMLButtonElement>('button[aria-label^="Close "]')!
    .click();
  (await until(() => button("Discard and close"), "discard choice")).click();
  await until(() => !first.isConnected, "old app window retired");
  second.contentWindow!.postMessage(
    { type: "desktop-probe", action: "window-clean-close" },
    "*",
  );
  await until(
    () => !document.querySelector('iframe[title="Native Notes"]'),
    "runtime windows retired",
  );
  checks.windowCleanClose = !second.isConnected;
  button("Remove").click();
  await until(() => !catalog.snapshot().length, "package removed");
  checks.removedAfterClose = true;
  const remembered = await localData.get(
    "org.shellcanvas.native-fixture",
    "data",
    "note",
    new AbortController().signal,
  );
  checks.storageSurvivesUninstall = remembered !== null;
  if (remembered)
    await localData.remove(
      "org.shellcanvas.native-fixture",
      "data",
      "note",
      remembered.revision,
      new AbortController().signal,
    );
  const result = {
    success: Object.values(checks).every(Boolean),
    checks,
    userAgent: navigator.userAgent,
  };
  if (isTauri()) await emit("shellcanvas-native-extension-probe", result);
  else {
    document.body.dataset.probeResult = JSON.stringify(result);
    console.log(result);
  }
}
void run().catch(async (error) => {
  const result = { success: false, error: String(error), checks };
  if (isTauri()) await emit("shellcanvas-native-extension-probe", result);
  else {
    document.body.dataset.probeResult = JSON.stringify(result);
    console.error(result);
  }
});
