// SPDX-License-Identifier: MPL-2.0
import type { Capability, FileEntry, SessionServices } from "./sdk";
import { commitSaveAs, prepareSaveAs } from "./save-as";
import {
  SystemError,
  type DialogControl,
  type FileSaveSelection,
  type MessageBoxOptions,
  type OpenFileOptions,
  type SaveFileOptions,
  type SystemAPI,
} from "./system-api";

type RequestContent =
  | { kind: "message"; options: MessageBoxOptions }
  | { kind: "open"; options: OpenFileOptions }
  | { kind: "save"; options: SaveFileOptions };
type Answer = string | readonly FileEntry[] | FileSaveSelection | null;
export type DialogRequest = RequestContent & {
  id: number;
  owner: SystemScope;
  returnFocus: HTMLElement | null;
  resolve(value: Answer): void;
  reject(error: Error): void;
};

/** One desktop queue; no React or Tauri dependency. Never share scope handles between windows. */
export class DialogQueue {
  private requests: readonly DialogRequest[] = [];
  private listeners = new Set<() => void>();
  private serial = 0;
  snapshot = () => this.requests;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(requests: readonly DialogRequest[]) {
    this.requests = requests;
    for (const listener of this.listeners) listener();
  }
  request(
    owner: SystemScope,
    content: RequestContent,
    control?: DialogControl,
  ): Promise<Answer> {
    owner.check(control);
    if (this.requests.length >= 32)
      throw new SystemError(
        "busy",
        "Too many system dialogs are waiting. Finish or cancel one first.",
      );
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      let settled = false;
      const finish = (value: Answer | Error) => {
        if (settled) return;
        settled = true;
        control?.signal?.removeEventListener("abort", abort);
        this.publish(this.requests.filter((request) => request.id !== id));
        value instanceof Error ? reject(value) : resolve(value);
      };
      const abort = () =>
        finish(new SystemError("aborted", "Dialog canceled by its caller."));
      const request: DialogRequest = {
        ...content,
        id,
        owner,
        returnFocus:
          typeof document === "undefined"
            ? null
            : (document.activeElement as HTMLElement | null),
        resolve: finish,
        reject: finish,
      };
      control?.signal?.addEventListener("abort", abort, { once: true });
      this.publish([...this.requests, request]);
    });
  }
  cancel(owner: SystemScope, error: SystemError) {
    for (const request of this.requests.filter(
      (request) => request.owner === owner,
    ))
      request.reject(error);
  }
}
export const desktopDialogs = new DialogQueue();

function text(
  value: unknown,
  label: string,
  maximum = 160,
): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new SystemError(
      "invalid",
      `${label} must contain 1–${maximum} characters.`,
    );
}
function fileOptions(options: OpenFileOptions | SaveFileOptions) {
  if (options.title !== undefined) text(options.title, "Title");
  if (options.directory !== undefined)
    text(options.directory, "Directory", 65536);
}
export class SystemScope {
  private active = true;
  private visible = true;
  readonly api: SystemAPI;
  constructor(
    readonly title: string,
    readonly services: SessionServices,
    private allowed: (capability: Capability) => boolean,
    readonly focus: () => void,
    private queue = desktopDialogs,
  ) {
    const dialogs: SystemAPI["dialogs"] = {
      messageBox: async (options, control) => {
        text(options.title, "Title");
        text(options.message, "Message", 16384);
        const buttons = (options.buttons ?? [{ id: "ok", label: "OK" }]).map(
          (button) => ({ ...button }),
        );
        if (!buttons.length || buttons.length > 4)
          throw new SystemError(
            "invalid",
            "A message box needs one to four buttons.",
          );
        const ids = new Set<string>();
        for (const button of buttons) {
          text(button.id, "Button ID", 64);
          text(button.label, "Button label", 80);
          if (ids.has(button.id))
            throw new SystemError("invalid", "Button IDs must be unique.");
          ids.add(button.id);
        }
        for (const id of [options.defaultId, options.cancelId])
          if (id !== undefined && !ids.has(id))
            throw new SystemError(
              "invalid",
              "Default and Cancel must identify existing buttons.",
            );
        if (
          options.kind &&
          !["info", "warning", "error"].includes(options.kind)
        )
          throw new SystemError("invalid", "Unknown message box kind.");
        const result = await queue.request(
          this,
          { kind: "message", options: { ...options, buttons } },
          control,
        );
        this.check(control);
        return result as string | null;
      },
      openFile: async (options = {}, control) => {
        this.require("files.read");
        fileOptions(options);
        if (options.kind && !["file", "directory"].includes(options.kind))
          throw new SystemError("invalid", "Choose files or folders.");
        if (
          options.extensions?.some(
            (extension) => !/^\.[^/\\\x00-\x20]+$/.test(extension),
          )
        )
          throw new SystemError(
            "invalid",
            "Filters must be filename suffixes such as .txt.",
          );
        const result = await queue.request(
          this,
          {
            kind: "open",
            options: {
              ...options,
              extensions: options.extensions && [...options.extensions],
            },
          },
          control,
        );
        this.require("files.read");
        this.check(control);
        return result as readonly FileEntry[] | null;
      },
      saveFile: async (options = {}, control) => {
        this.require("files.read");
        fileOptions(options);
        if (options.name !== undefined) text(options.name, "File name", 1024);
        const result = await queue.request(
          this,
          { kind: "save", options: { ...options } },
          control,
        );
        this.require("files.read");
        this.check(control);
        return result as FileSaveSelection | null;
      },
    };
    this.api = Object.freeze({
      apiVersion: 1,
      dialogs: Object.freeze(dialogs),
      files: Object.freeze({
        saveTextAs: async (
          options: SaveFileOptions & { text: string },
          control?: DialogControl,
        ) => {
          const { text: contents, ...selectionOptions } = options;
          if (typeof contents !== "string")
            throw new SystemError("invalid", "Text contents are required.");
          this.require("files.create");
          const selected = await dialogs.saveFile(selectionOptions, control);
          if (!selected) return null;
          const target = await prepareSaveAs(
            services,
            selected.parent,
            selected.name,
            this.allowed("files.edit"),
          );
          this.check(control);
          if (target.kind === "replace") {
            const answer = await dialogs.messageBox(
              {
                title: "Replace existing file?",
                kind: "warning",
                message: `Replace “${target.name}” with your draft? The current file contents will be replaced.`,
                buttons: [
                  { id: "cancel", label: "Keep editing" },
                  { id: "replace", label: "Replace file", destructive: true },
                ],
                defaultId: "cancel",
                cancelId: "cancel",
              },
              control,
            );
            if (answer !== "replace") return null;
          }
          this.check(control);
          this.require(
            target.kind === "replace" ? "files.edit" : "files.create",
          );
          const saved = await commitSaveAs(services, target, contents);
          this.check(control);
          return saved;
        },
      }),
    });
  }
  check(control?: DialogControl) {
    if (!this.active)
      throw new SystemError(
        "closed",
        "The owning window or session is no longer active.",
      );
    if (!this.visible)
      throw new SystemError(
        "aborted",
        "The owning window or workspace is hidden.",
      );
    if (control?.signal?.aborted)
      throw new SystemError("aborted", "Operation canceled by its caller.");
  }
  require(capability: Capability) {
    this.check();
    if (!this.allowed(capability))
      throw new SystemError(
        "unavailable",
        `This app cannot use ${capability} in the current workspace.`,
      );
  }
  activate() {
    this.active = true;
  }
  dispose() {
    this.active = false;
    this.queue.cancel(
      this,
      new SystemError("closed", "The owning window or session was closed."),
    );
  }
  suspend() {
    this.queue.cancel(
      this,
      new SystemError(
        "aborted",
        "Dialog closed because its window or workspace was hidden.",
      ),
    );
  }
  setVisible(value: boolean) {
    this.visible = value;
    if (!value) this.suspend();
  }
}
