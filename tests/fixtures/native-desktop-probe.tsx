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
const services = {
  ...previewServices,
  connect: async () => ({ ...previewSession, id: ++sessionSerial }),
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
    storage?: Record<string, unknown>;
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
        initialSession={previewSession}
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
  const secondEnvironment = await ask(second, "environment");
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
  first
    .closest(".app-window")!
    .querySelector<HTMLButtonElement>('button[aria-label^="Close "]')!
    .click();
  (await until(() => button("Keep working"), "dirty close review")).click();
  checks.keepWorking =
    (await ask(first)).text === "A draft kept across package updates.";
  first
    .closest(".app-window")!
    .querySelector<HTMLButtonElement>('button[aria-label^="Close "]')!
    .click();
  (await until(() => button("Discard and close"), "discard choice")).click();
  await until(() => !first.isConnected, "old app window retired");
  second
    .closest(".app-window")!
    .querySelector<HTMLButtonElement>('button[aria-label^="Close "]')!
    .click();
  (
    await until(() => button("Discard and close"), "updated app dirty close")
  ).click();
  await until(
    () => !document.querySelector('iframe[title="Native Notes"]'),
    "runtime windows retired",
  );
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
