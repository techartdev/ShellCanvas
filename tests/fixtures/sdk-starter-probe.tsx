// SPDX-License-Identifier: MPL-2.0
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import App from "../../src/App";
import { apps } from "../../src/apps/registry";
import {
  AppCatalog,
  indexedCatalogStorage,
} from "../../src/extensions/catalog";
import { DesktopRuntime } from "../../src/extensions/desktop-runtime";
import { indexedAppStorage } from "../../src/extensions/app-storage";
import { previewServices, previewSession } from "../../src/preview";
import type { HostServices, Session, TextDocument } from "../../src/sdk";
import source from "../../.local/sdk-verification/starter-probe.shellcanvas.json?raw";
import "../../src/styles.css";
const checks: Record<string, boolean> = {};
const catalog = new AppCatalog(
  indexedCatalogStorage("shellcanvas-sdk-starter-probe"),
);
const storage = indexedAppStorage("shellcanvas-sdk-starter-probe-storage");
const runtime = new DesktopRuntime(catalog, apps, storage);
const documents = new Map<string, TextDocument>();
const session: Session = {
  ...previewSession,
  info: {
    ...previewSession.info,
    capabilities: ["files.read", "files.create"],
  },
};
const services: HostServices = {
  ...previewServices,
  async list(id, path) {
    const directory = await previewServices.list(id, path);
    return {
      ...directory,
      entries: [
        ...directory.entries,
        ...[...documents.values()]
          .filter((item) => item.parent === directory.path)
          .map((item) => ({
            name: item.name,
            path: item.path,
            kind: "file" as const,
            revision: item.revision,
            size: new TextEncoder().encode(item.text).length,
            modified: null,
          })),
      ],
    };
  },
  async createText(id, parent, name, text) {
    if (
      (await services.list(id, parent)).entries.some(
        (item) => item.name === name,
      )
    )
      throw new Error("Destination already exists");
    const result = {
      name,
      parent,
      path: `${parent}/${name}`,
      text,
      writable: true,
      revision: crypto.randomUUID(),
    };
    documents.set(result.path, result);
    return result;
  },
};
async function until<T>(read: () => T, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
async function click(label: string, root: ParentNode = document) {
  (
    await until(
      () =>
        Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => !button.disabled && button.textContent?.trim() === label,
        ),
      label,
    )
  ).click();
}
type Snapshot = {
  title?: string;
  status?: string;
  note?: string;
  ready: boolean;
};
async function ask(
  frame: HTMLIFrameElement,
  action = "snapshot",
): Promise<Snapshot> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.contentWindow ||
        event.data?.type !== "sdk-starter-result" ||
        event.data.id !== id
      )
        return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolve(event.data);
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Starter frame did not answer"));
    }, 3000);
    window.addEventListener("message", receive);
    frame.contentWindow?.postMessage(
      { type: "sdk-starter-probe", id, action },
      "*",
    );
  });
}
async function ready(
  frame: HTMLIFrameElement,
  predicate: (state: Snapshot) => boolean,
) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    // The native resource URL is assigned before the frame's script has loaded.
    try {
      const value = await ask(frame);
      if (predicate(value)) return value;
    } catch {
      /* Retry the read-only probe while this newly opened frame loads. */
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Starter did not reach expected state");
}
async function run() {
  await catalog.load();
  for (const entry of catalog.snapshot())
    await catalog.remove(entry.package.id, entry.generation);
  const previous = await storage.get(
    "org.example.sdk-starter",
    "data",
    "note",
    new AbortController().signal,
  );
  if (previous)
    await storage.remove(
      "org.example.sdk-starter",
      "data",
      "note",
      previous.revision,
      new AbortController().signal,
    );
  createRoot(document.getElementById("root")!).render(
    <App
      services={services}
      initialSession={session}
      isNative
      appRuntime={runtime}
    />,
  );
  (
    await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="Open Apps"]',
        ),
      "Apps",
    )
  ).click();
  const input = await until(
    () =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Select app package"]',
      ),
    "package picker",
  );
  const data = new DataTransfer();
  data.items.add(
    new File([source], "starter.shellcanvas.json", {
      type: "application/json",
    }),
  );
  input.files = data.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => document.querySelector(".extension-review"), "review");
  await click("Install app", document.querySelector(".extension-review")!);
  await click("Open app");
  const frame = await until(
    () =>
      document.querySelector<HTMLIFrameElement>(
        'iframe[title="Workspace Notes"]',
      ),
    "starter window",
  );
  await until(
    () => frame.getAttribute(isTauri() ? "src" : "srcdoc"),
    "frame document",
  );
  const first = await ready(frame, (state) => state.ready);
  checks.starterInstalled = first.title === "Workspace Notes";
  if (!isTauri() && new URL(location.href).searchParams.has("inspect")) return;
  await ask(frame, "message");
  const message = await until(
    () =>
      document.querySelector<HTMLDialogElement>(
        'dialog[aria-label="Hello from your app"]',
      ),
    "shared message box",
  );
  await click("OK", message);
  await ready(
    frame,
    (state) => state.ready && state.status === "Dialog closed.",
  );
  checks.sharedMessage = true;
  for (const action of ["browse", "save"]) {
    await ask(frame, action);
    const picker = await until(
      () => document.querySelector<HTMLDialogElement>("dialog.system-picker"),
      `${action} picker`,
    );
    await click("Cancel", picker);
    await ready(
      frame,
      (state) => state.ready && !!state.status?.includes("canceled"),
    );
    checks[`${action}Picker`] = true;
  }
  await ask(frame, "edit");
  await ask(frame, "save");
  const save = await until(
    () => document.querySelector<HTMLDialogElement>("dialog.system-picker"),
    "save workflow",
  );
  await click("Choose destination", save);
  await ready(
    frame,
    (state) => state.ready && !!state.status?.startsWith("Saved "),
  );
  checks.savedText = [...documents.values()].some(
    (item) => item.text === "A note built outside the desktop repository.",
  );
  await ask(frame, "remember");
  await ready(
    frame,
    (state) =>
      state.ready && state.status === "Remembered locally for this app.",
  );
  checks.localStorage =
    (
      await storage.get(
        "org.example.sdk-starter",
        "data",
        "note",
        new AbortController().signal,
      )
    )?.value === "A note built outside the desktop repository.";
  await ask(frame, "edit");
  await until(
    () => document.querySelector('[aria-label="Unsaved changes"]'),
    "reported dirty state",
  );
  (
    await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          'button[aria-label^="Close Workspace Notes"]',
        ),
      "close starter",
    )
  ).click();
  await until(
    () => document.querySelector(".confirm-dialog"),
    "dirty close review",
  );
  checks.dirtyClose = true;
  await click("Keep working");
  checks.draftPreserved =
    (await ask(frame)).note === "A note built outside the desktop repository.";
  const result = { success: Object.values(checks).every(Boolean), checks };
  if (isTauri()) await emit("shellcanvas-native-extension-probe", result);
  else document.body.dataset.probeResult = JSON.stringify(result);
}
void run().catch(async (error) => {
  const result = {
    success: false,
    checks,
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  if (isTauri()) await emit("shellcanvas-native-extension-probe", result);
  else document.body.dataset.probeResult = JSON.stringify(result);
});
