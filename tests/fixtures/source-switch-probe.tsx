// SPDX-License-Identifier: MPL-2.0
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { WorkspaceWindows } from "../../src/components/WorkspaceWindows";
import { SystemDialogHost } from "../../src/components/SystemDialogHost";
import { apps } from "../../src/apps/registry";
import {
  AppCatalog,
  indexedCatalogStorage,
} from "../../src/extensions/catalog";
import { DesktopRuntime } from "../../src/extensions/desktop-runtime";
import { initialDesktop, updateDesktop } from "../../src/desktop";
import { previewServices, previewSession } from "../../src/preview";
import type { Workspace } from "../../src/workspaces";
import {
  capabilityLabels,
  type HostServices,
  type Session,
} from "../../src/sdk";
import "../../src/styles.css";

const runtime = new DesktopRuntime(
  new AppCatalog(indexedCatalogStorage("shellcanvas-source-probe")),
  apps,
);
const checks: Record<string, boolean> = {};
const errors: string[] = [];
const reads: string[] = [];
const writes: { source: number; path: string; text: string }[] = [];
let opens = 0,
  closes = 0,
  inputs = 0,
  foreignPaths = 0;
function session(source: number): Session {
  const files = { instance: source, generation: 1, adapter: "fixture-files" };
  const console = { instance: 99, generation: 1, adapter: "fixture-console" };
  const capabilities = [
    "files.read",
    "files.edit",
    "files.create",
    "terminal",
  ] as const;
  return {
    ...previewSession,
    id: 710,
    info: {
      ...previewSession.info,
      hostname: "Source switch fixture",
      capabilities: [...capabilities],
    },
    connections: [files, console],
    customSources: {},
    services: Object.keys(capabilityLabels).map((capability) => ({
      capability: capability as keyof typeof capabilityLabels,
      state: capabilities.includes(capability as (typeof capabilities)[number])
        ? "available"
        : "unsupported",
      source: capability === "terminal" ? console : files,
    })),
  };
}
function backend(source = 1): HostServices {
  const root = `opaque:${source}:root`;
  const path = `opaque:${source}:document`;
  const validate = (value: string) => {
    if (value !== root && value !== path) {
      foreignPaths++;
      throw new Error("Foreign provider location");
    }
  };
  const document = (text: string) => ({
    path,
    parent: root,
    name: "draft.txt",
    text,
    revision: "revision",
    writable: true,
  });
  return {
    ...previewServices,
    bindSources: (accepted) => backend(accepted.connections![0].instance),
    list: async (_, location) => {
      validate(location ?? root);
      reads.push(location ?? root);
      return {
        path: root,
        name: `Files source ${source}`,
        parent: null,
        home: null,
        roots: [{ path: root, name: `Files source ${source}` }],
        entries:
          source === 1
            ? [
                {
                  path,
                  name: "draft.txt",
                  kind: "file",
                  size: 12,
                  modified: null,
                },
              ]
            : [],
      };
    },
    readText: async (_, location) => {
      validate(location);
      return document("Original draft");
    },
    saveText: async (_, location, text) => {
      validate(location);
      writes.push({ source, path: location, text });
      return document(text);
    },
    createText: async (_, location, _name, text) => {
      validate(location);
      writes.push({ source, path: location, text });
      return document(text);
    },
    terminal: async (_, _cols, _rows, event) => {
      opens++;
      return {
        write: async (text) => {
          inputs++;
          event({ type: "output", data: [...new TextEncoder().encode(text)] });
        },
        resize: async () => {},
        close: async () => {
          closes++;
        },
      };
    },
  };
}
const services = backend();
let replace: (source: number) => void;
function Desktop() {
  const [workspace, setWorkspace] = useState<Workspace>(() => ({
    key: "source-probe",
    label: "Source probe",
    connected: true,
    session: session(1),
    desktop: updateDesktop(
      initialDesktop(apps),
      { type: "new", id: "editor", launch: { path: "opaque:1:document" } },
      apps,
    ),
  }));
  replace = (source) =>
    setWorkspace((current) => ({ ...current, session: session(source) }));
  return (
    <>
      <div className="windows-area" style={{ inset: "20px 0 40px" }}>
        <WorkspaceWindows
          workspace={workspace}
          runtime={runtime}
          backend={services}
          active
          preview={false}
          dispatch={(action) =>
            setWorkspace((current) => ({
              ...current,
              desktop: updateDesktop(current.desktop, action, apps),
            }))
          }
          connect={() => {}}
          reportError={(message) => errors.push(message)}
        />
      </div>
      <SystemDialogHost />
    </>
  );
}
async function until<T>(read: () => T, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}; errors=${errors.join("; ")}`);
}
function control(label: string) {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
}
function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    "value",
  )!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
async function run() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Desktop />
    </StrictMode>,
  );
  const editor = await until(() => {
    const el = document.querySelector<HTMLTextAreaElement>(
      ".editor-buffer textarea",
    );
    return el?.value === "Original draft" ? el : null;
  }, "editor loaded");
  await until(
    () => opens && reads.includes("opaque:1:root"),
    "initial services",
  );
  setValue(editor, "Unsaved draft survives");
  await until(() => !control("Save file").disabled, "draft dirty");
  const terminal = document.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  )!;
  const originalOpens = opens,
    originalCloses = closes;
  replace(2);
  await until(
    () =>
      document.querySelector(".editor-source-notice") &&
      reads.includes("opaque:2:root"),
    "source switched",
  );
  checks.editorElementPreserved =
    editor === document.querySelector(".editor-buffer textarea");
  checks.draftPreserved = editor.value === "Unsaved draft survives";
  checks.oldSaveAndReloadDisabled =
    control("Save file").disabled && control("Reload remote file").disabled;
  checks.terminalPreserved =
    terminal === document.querySelector(".xterm-helper-textarea") &&
    opens === originalOpens &&
    closes === originalCloses;
  terminal.dispatchEvent(
    new KeyboardEvent("keypress", {
      key: "x",
      code: "KeyX",
      charCode: 120,
      keyCode: 120,
      bubbles: true,
    }),
  );
  await until(() => inputs > 0, "terminal input after replacement");
  checks.terminalStillAcceptsInput = true;
  control("Undo edit").click();
  await until(() => editor.value === "Original draft", "undo preserved");
  control("Redo edit").click();
  await until(
    () => editor.value === "Unsaved draft survives",
    "redo preserved",
  );
  checks.undoHistoryPreserved = true;
  control("Save file as").click();
  const picker = await until(
    () =>
      document.querySelector<HTMLDialogElement>("dialog.system-picker[open]"),
    "save picker",
  );
  await until(
    () => picker.textContent?.includes("Files source 2"),
    "replacement root in picker",
  );
  checks.savePickerUsesNewRoot = true;
  const save = await until(
    () =>
      [...picker.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) =>
          button.textContent?.trim() === "Choose destination" &&
          !button.disabled,
      ),
    "save action",
  );
  save.click();
  await until(
    () => writes.length && !document.querySelector(".editor-source-notice"),
    "new source save",
  );
  checks.savedOnlyToReplacement =
    writes.length === 1 &&
    writes[0].source === 2 &&
    writes[0].path === "opaque:2:root" &&
    writes[0].text === "Unsaved draft survives";
  checks.noOldLocationSentToNewSource = foreignPaths === 0;
  checks.noUnexpectedErrors = errors.length === 0;
  return { success: Object.values(checks).every(Boolean), checks, errors };
}
void run()
  .catch((error) => ({ success: false, error: String(error), checks, errors }))
  .then(async (result) => {
    document.body.dataset.probeResult = JSON.stringify(result);
    if (isTauri()) await emit("shellcanvas-native-extension-probe", result);
    else console.log(result);
  });
