// SPDX-License-Identifier: MPL-2.0
import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Files } from "../../src/apps/Files";
import { MoveFileDialog } from "../../src/components/MoveFileDialog";
import { SystemDialogHost } from "../../src/components/SystemDialogHost";
import { previewServices, previewSession } from "../../src/preview";
import { bindSession } from "../../src/session-services";
import { DialogQueue, SystemScope } from "../../src/system-dialogs";
import type {
  Directory,
  DirectoryPage,
  FileEntry,
  HostServices,
} from "../../src/sdk";
import "../../src/styles.css";

const checks: Record<string, boolean> = {};
const errors: string[] = [];
const scans: {
  path: string;
  reads: number;
  closed: boolean;
  release?: () => void;
}[] = [];
let legacyReads = 0;
const entry = (
  path: string,
  name = path,
  kind: FileEntry["kind"] = "file",
): FileEntry => ({
  path,
  name,
  kind,
  size: 12,
  modified: null,
  revision: "v1",
});
function page(
  path: string,
  entries: FileEntry[],
  done: boolean,
): DirectoryPage {
  return {
    directory: {
      path,
      name: path,
      parent: path === "root" ? null : "root",
      home: { path: "root", name: "Home" },
      roots: [
        { path: "large", name: "Large folder" },
        { path: "next", name: "Next folder" },
      ],
      entries,
    },
    done,
  };
}
const backend: HostServices = {
  ...previewServices,
  list: async () => {
    legacyReads++;
    throw new Error("Materialized listing must not be used");
  },
  openDirectory: async (_, path = "root") => {
    const scan = {
      path,
      reads: 0,
      closed: false,
      release: undefined as (() => void) | undefined,
    };
    scans.push(scan);
    let offset = 0;
    return {
      next: async () => {
        scan.reads++;
        if (path === "root") {
          if (scan.reads === 1)
            return page(
              path,
              [
                entry("next", "Next folder", "directory"),
                entry("large", "Large folder", "directory"),
                ...Array.from({ length: 126 }, (_, n) => entry(`root:${n}`)),
              ],
              false,
            );
          await new Promise<void>((resolve) => {
            scan.release = resolve;
          });
          return page(path, [entry("late:old", "Late old entry")], true);
        }
        if (path === "large" || path === "folders") {
          const result = Array.from(
            { length: Math.min(128, 50_000 - offset) },
            (_, n) =>
              entry(
                `${path}:${offset + n}`,
                `Item ${String(offset + n).padStart(5, "0")}`,
                path === "folders" ? "directory" : "file",
              ),
          );
          offset += result.length;
          return page(path, result, offset === 50_000);
        }
        return page(
          path,
          [
            entry("next:1", "Next one"),
            entry("next:2", "Next two"),
            entry("next:3", "Next three"),
          ],
          true,
        );
      },
      close: async () => {
        scan.closed = true;
      },
    };
  },
};
const bound = bindSession(
  backend,
  previewSession,
  (message) => errors.push(message),
  { clipboardLifecycle: false },
);
const queue = new DialogQueue();
const scope = new SystemScope(
  "Directory fixture",
  bound.services,
  () => true,
  () => {},
  queue,
);
let showMove: (value: boolean) => void;
let showFiles: (value: boolean) => void;
function Desktop() {
  const [move, setMove] = useState(false);
  showMove = setMove;
  const [files, setFiles] = useState(true);
  showFiles = setFiles;
  useLayoutEffect(() => {
    bound.activate();
    return () => bound.dispose();
  }, []);
  return (
    <>
      <div
        style={{
          position: "absolute",
          display: "flex",
          inset: "18px 18px 58px",
          border: "1px solid #65818a",
          borderRadius: 12,
          overflow: "hidden",
          background: "#192d38",
        }}
      >
        {files && (
          <Files
            session={previewSession}
            services={bound.services}
            preview={false}
            active
            connected
            reportError={(message) => errors.push(message)}
            connect={() => {}}
          />
        )}
      </div>
      {move && (
        <MoveFileDialog
          entry={entry("source-file")}
          initialParent="folders"
          services={bound.services}
          disabled={false}
          close={() => setMove(false)}
          setBusy={() => {}}
        />
      )}
      <SystemDialogHost queue={queue} />
      <output
        id="probe-result"
        style={{
          position: "absolute",
          bottom: 10,
          left: 20,
          right: 20,
          maxHeight: 38,
          overflow: "auto",
          overflowWrap: "anywhere",
          color: "#b7dbd1",
          font: "12px monospace",
        }}
      >
        Checking progressive discovery…
      </output>
    </>
  );
}
async function until<T>(read: () => T, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}; ${errors.join("; ")}`);
}
function assert(name: string, value: unknown) {
  checks[name] = !!value;
  if (!value) throw new Error(`Failed: ${name}`);
}
function button(root: ParentNode, label: string) {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (el) => el.textContent?.trim() === label,
  )!;
}
function path(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Remote path"]',
  )!;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.form!.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 70));
}
async function run() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Desktop />
    </StrictMode>,
  );
  const first = await until(
    () =>
      scans.find(
        (item) => item.path === "root" && item.reads === 2 && !item.closed,
      ),
    "pending second page",
  );
  await until(() => document.querySelector(".file-row"), "visible first page");
  assert(
    "firstPageVisibleWhilePending",
    document
      .querySelector(".files-footer")
      ?.textContent?.includes("discovering"),
  );
  const next = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".file-row"),
  ).find((el) => el.textContent?.includes("Next folder"))!;
  next.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await until(
    () =>
      document.querySelector(".folder-heading")?.textContent?.includes("next"),
    "new location",
  );
  await until(() => first.closed, "old reader closed");
  first.release!();
  await settle();
  assert(
    "latePageCannotReplaceNavigation",
    !document
      .querySelector(".file-table")
      ?.textContent?.includes("Late old entry"),
  );
  path("large");
  await until(
    () =>
      document
        .querySelector(".files-footer")
        ?.textContent?.includes("50000 items") &&
      !document
        .querySelector(".files-footer")
        ?.textContent?.includes("discovering"),
    "large inventory",
  );
  assert(
    "largeInventoryUsesBoundedRows",
    document.querySelectorAll(".file-row").length < 80,
  );
  const table = document.querySelector<HTMLDivElement>(".file-table")!;
  const row = table.querySelector<HTMLButtonElement>(".file-row")!;
  row.focus();
  row.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  await until(
    () => document.activeElement?.textContent?.includes("Item 49999"),
    "keyboard End",
  );
  assert(
    "keyboardReachesLastEntry",
    document.activeElement?.getAttribute("data-virtual-index") === "49999",
  );
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
  );
  await until(
    () => document.activeElement?.textContent?.includes("Item 00000"),
    "keyboard Home",
  );
  table.scrollTop = table.scrollHeight;
  table.dispatchEvent(new Event("scroll"));
  await until(
    () => table.textContent?.includes("Item 49999"),
    "scroll reaches final entry",
  );
  assert(
    "scrollReachesLastEntry",
    table.querySelectorAll(".file-row").length < 80,
  );
  table
    .querySelector<HTMLButtonElement>('[data-virtual-index="49999"]')!
    .click();
  await settle();
  const beforeRefresh = scans.length;
  document
    .querySelector<HTMLButtonElement>('[aria-label="Refresh directory"]')!
    .click();
  await until(
    () =>
      scans.length > beforeRefresh &&
      scans.at(-1)!.closed &&
      !document
        .querySelector(".files-footer")
        ?.textContent?.includes("discovering"),
    "refresh complete",
  );
  assert(
    "latePageSelectionSurvivesRefresh",
    document
      .querySelector(".files-footer")
      ?.textContent?.includes("1 selected"),
  );

  const opened = scope.api.dialogs.openFile({
    directory: "root",
    multiple: true,
  });
  const picker = await until(
    () => document.querySelector<HTMLDialogElement>(".system-dialog[open]"),
    "open picker",
  );
  const pickerScan = await until(
    () =>
      [...scans]
        .reverse()
        .find(
          (item) => item.path === "root" && item.reads === 2 && !item.closed,
        ),
    "picker paused",
  );
  assert(
    "pickerShowsFirstPage",
    picker.querySelectorAll(".system-picker-list > button").length > 0,
  );
  button(picker, "Cancel").click();
  await opened;
  await until(() => pickerScan.closed, "picker reader closed");
  pickerScan.release!();
  const largePicker = scope.api.dialogs.openFile({
    directory: "large",
    multiple: true,
  });
  const dialog = await until(
    () => document.querySelector<HTMLDialogElement>(".system-dialog[open]"),
    "large picker",
  );
  await until(
    () => dialog.querySelector('.system-picker-list[aria-busy="false"]'),
    "picker scan complete",
  );
  assert(
    "pickerUsesBoundedRows",
    dialog.querySelectorAll(".system-picker-list > button").length < 80,
  );
  const lastStart = dialog.querySelector<HTMLButtonElement>(
    ".system-picker-list > button",
  )!;
  lastStart.focus();
  lastStart.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  await until(
    () => document.activeElement?.textContent?.includes("Item 49999"),
    "picker End",
  );
  (document.activeElement as HTMLButtonElement).click();
  await settle();
  button(dialog, "Open").click();
  const selected = await largePicker;
  assert(
    "pickerReturnsOriginalOpaqueEntry",
    selected?.length === 1 && selected[0].path === "large:49999",
  );

  showMove(true);
  const move = await until(
    () => document.querySelector<HTMLDialogElement>(".move-file-dialog[open]"),
    "move picker",
  );
  await until(
    () => move.querySelector('.move-folder-list[aria-busy="false"]'),
    "move scan complete",
  );
  assert(
    "movePickerUsesBoundedRows",
    move.querySelectorAll(".move-folder-list button").length < 80,
  );
  const moveFirst = move.querySelector<HTMLButtonElement>(
    ".move-folder-list button",
  )!;
  moveFirst.focus();
  moveFirst.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  await until(
    () => document.activeElement?.textContent?.includes("Item 49999"),
    "move End",
  );
  assert(
    "movePickerReachesLastFolder",
    document.activeElement?.getAttribute("data-virtual-index") === "49999",
  );
  button(move, "Cancel").click();
  await settle();
  path("root");
  const closing = await until(
    () =>
      [...scans]
        .reverse()
        .find(
          (item) => item.path === "root" && item.reads === 2 && !item.closed,
        ),
    "closing Files scan",
  );
  showFiles(false);
  await until(() => closing.closed, "Files disposal");
  closing.release!();
  assert("noMaterializedFallback", legacyReads === 0);
  assert(
    "noUnclosedReaders",
    scans.every((item) => item.closed),
  );
  showFiles(true);
  await settle();
  path("large");
  for (const item of scans) if (item.closed) item.release?.();
}
void run()
  .then(() => {
    const output = document.getElementById("probe-result")!;
    output.textContent = JSON.stringify({
      success: true,
      checks,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    output.dataset.success = "true";
  })
  .catch((error) => {
    const output = document.getElementById("probe-result")!;
    output.textContent = JSON.stringify({
      success: false,
      checks,
      error: String(error),
    });
    output.dataset.success = "false";
  });
