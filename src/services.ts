// SPDX-License-Identifier: MPL-2.0
import { Channel, invoke as nativeInvoke, isTauri } from "@tauri-apps/api/core";
import { createNativeCustomServices } from "./custom-services";
import type {
  HostServices,
  ConnectionIdentity,
  HostKeyChallenge,
  Session,
  TerminalEvent,
  TransferProgress,
} from "./sdk";
export const native = isTauri();
type SourcePins = {
  sessionId: number;
  files?: ConnectionIdentity;
  console?: ConnectionIdentity;
  settings?: ConnectionIdentity;
  custom: Readonly<Record<string, ConnectionIdentity>>;
};
const commandRoles: Record<string, "files" | "console" | "settings"> = {
  paste_system_files: "files",
  cut_system_file: "files",
  copy_system_files: "files",
  choose_download_files: "files",
  prepare_file_copy: "files",
  prepare_file_copy_selection: "files",
  choose_upload_files: "files",
  choose_download_file: "files",
  create_text: "files",
  make_directory: "files",
  rename_entry: "files",
  move_entry: "files",
  remove_entry: "files",
  list_directory: "files",
  preview_file: "files",
  read_text: "files",
  save_text: "files",
  read_host_settings: "settings",
  apply_host_setting: "settings",
  open_terminal: "console",
};
function createNativeServices(pins?: SourcePins): HostServices {
  const invoke = <T>(
    ...parameters: Parameters<typeof nativeInvoke>
  ): Promise<T> => {
    const [command, args] = parameters;
    const role = commandRoles[command];
    if (role && pins) {
      const values = args as Record<string, unknown> | undefined;
      if (values?.sessionId !== pins.sessionId)
        return Promise.reject(
          new Error("Service binding belongs to another workspace"),
        );
      const binding = pins[role];
      if (!binding)
        return Promise.reject(
          new Error("No accepted connection supplies this service"),
        );
      parameters[1] = { ...values, binding: { ...binding } };
    }
    return nativeInvoke<T>(...parameters);
  };
  return {
    bindSources(session) {
      const capture = (family: "files" | "console" | "settings") => {
        const source = session.services?.find((item) =>
          family === "files"
            ? item.capability.startsWith("files.") && item.source
            : item.capability ===
              (family === "console" ? "terminal" : "host.settings"),
        )?.source;
        return source ? { ...source } : undefined;
      };
      return createNativeServices({
        sessionId: session.id,
        files: capture("files"),
        console: capture("console"),
        settings: capture("settings"),
        custom: structuredClone(session.customSources ?? {}),
      });
    },
    custom: createNativeCustomServices(
      pins ? { sessionId: pins.sessionId, sources: pins.custom } : undefined,
    ),
    cancelClipboardPreparation: (sessionId, operation) =>
      invoke("cancel_clipboard_preparation", { sessionId, operation }),
    systemClipboardSequence: () => invoke("system_clipboard_sequence"),
    pasteSystemFiles: (sessionId, parent) =>
      invoke("paste_system_files", { sessionId, parent }),
    cutToSystem: (sessionId, path, revision, preparation) => {
      const onEvent = new Channel<TransferProgress>();
      onEvent.onmessage = preparation?.onProgress ?? (() => {});
      return invoke("cut_system_file", {
        sessionId,
        path,
        revision,
        operation: preparation?.id,
        onEvent,
      });
    },
    systemFileClipboard:
      native &&
      typeof navigator !== "undefined" &&
      /Windows/.test(navigator.userAgent),
    copyToSystem: (sessionId, files, preparation) => {
      const onEvent = new Channel<TransferProgress>();
      onEvent.onmessage = preparation?.onProgress ?? (() => {});
      return invoke("copy_system_files", {
        sessionId,
        files,
        operation: preparation?.id,
        onEvent,
      });
    },
    chooseDownloads: (sessionId, files) =>
      invoke("choose_download_files", { sessionId, files }),
    prepareCopy: (sessionId, path, revision, parent) =>
      invoke("prepare_file_copy", { sessionId, path, revision, parent }),
    prepareCopySelection: (sessionId, files, parent) =>
      invoke("prepare_file_copy_selection", { sessionId, files, parent }),
    readHostSettings: (sessionId) =>
      invoke("read_host_settings", { sessionId }),
    applyHostSetting: (sessionId, id, value, revision) =>
      invoke("apply_host_setting", { sessionId, id, value, revision }),
    chooseUploads: (sessionId, parent, folder = false) =>
      invoke("choose_upload_files", { sessionId, parent, folder }),
    chooseDownload: (sessionId, path, revision) =>
      invoke("choose_download_file", { sessionId, path, revision }),
    runTransfer: (sessionId, transferId, onProgress) => {
      const onEvent = new Channel<TransferProgress>();
      onEvent.onmessage = onProgress;
      return invoke("run_transfer", { sessionId, transferId, onEvent });
    },
    cancelTransfer: (sessionId, transferId) =>
      invoke("cancel_transfer", { sessionId, transferId }),
    createText: (sessionId, parent, name, text) =>
      invoke("create_text", { sessionId, parent, name, text }),
    makeDirectory: (sessionId, parent, name) =>
      invoke("make_directory", { sessionId, parent, name }),
    renameEntry: (sessionId, path, name, revision, tracked) =>
      invoke("rename_entry", { sessionId, path, name, revision, tracked }),
    moveEntry: (sessionId, path, parent, revision, tracked) =>
      invoke("move_entry", { sessionId, path, parent, revision, tracked }),
    removeEntry: (sessionId, path, revision) =>
      invoke("remove_entry", { sessionId, path, revision }),
    profiles: () => invoke("profiles"),
    saveProfile: (profile) => invoke("save_profile", { profile }),
    removeProfile: (id) => invoke("remove_profile", { id }),
    connect: async (options, signal, reviewHostKey) => {
      if (signal?.aborted) throw new Error("Connection canceled");
      const requestId = await invoke<number>("begin_connect");
      const cancel = () => {
        void invoke("cancel_connect", { requestId }).catch((error) =>
          console.warn("Connection cancellation failed", error),
        );
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let finished = false;
      let reviewError: unknown;
      const onHostKey = new Channel<HostKeyChallenge>();
      onHostKey.onmessage = (challenge) => {
        void (async () => {
          if (finished || signal?.aborted) return;
          if (
            challenge.host.toLowerCase() !== options.host.toLowerCase() ||
            challenge.port !== options.port
          )
            throw new Error("Host-key review does not match this connection.");
          const approve = (await reviewHostKey?.(challenge)) ?? false;
          if (finished || signal?.aborted) return;
          await invoke("decide_host_key", {
            requestId,
            token: challenge.token,
            approve,
          });
        })().catch((error) => {
          reviewError = error;
          cancel();
        });
      };
      try {
        if (signal?.aborted) {
          await invoke("cancel_connect", { requestId });
          throw new Error("Connection canceled");
        }
        const result = await invoke<Session>("connect", {
          options,
          requestId,
          onHostKey,
        });
        if (signal?.aborted) {
          await invoke("disconnect", { sessionId: result.id });
          throw new Error("Connection canceled");
        }
        return result;
      } catch (error) {
        throw reviewError ?? error;
      } finally {
        finished = true;
        signal?.removeEventListener("abort", cancel);
        // Also release a registration if IPC failed before connect claimed it.
        cancel();
      }
    },
    disconnect: (sessionId) => invoke("disconnect", { sessionId }),
    alive: (sessionId) => invoke("session_alive", { sessionId }),
    status: (sessionId) => invoke("session_status", { sessionId }),
    list: (sessionId, path) => invoke("list_directory", { sessionId, path }),
    preview: (sessionId, path) => invoke("preview_file", { sessionId, path }),
    readText: (sessionId, path) => invoke("read_text", { sessionId, path }),
    saveText: (sessionId, path, text, revision) =>
      invoke("save_text", { sessionId, path, text, revision }),
    terminal: async (sessionId, cols, rows, onEvent) => {
      const channel = new Channel<
        TerminalEvent & { sequence?: number | null }
      >();
      let retired = false;
      let opening: Promise<{ id: number; resizable: boolean }>;
      channel.onmessage = (event) => {
        if (retired) return;
        void (async () => {
          await onEvent(event);
          if (event.type === "output" && !retired) {
            const { id: terminalId } = await opening;
            if (!retired)
              await invoke("acknowledge_terminal_output", {
                sessionId,
                terminalId,
                sequence: event.sequence,
              });
          }
        })().catch(async (error) => {
          if (retired) return;
          retired = true;
          try {
            await onEvent({
              type: "error",
              data: `Console delivery failed: ${error}`,
            });
          } catch {
            /* Consumer failed. */
          }
          try {
            const { id: terminalId } = await opening;
            await invoke("close_terminal", { sessionId, terminalId });
          } catch {
            /* An unsuccessful open has no retained terminal. */
          }
        });
      };
      opening = invoke<{ id: number; resizable: boolean }>("open_terminal", {
        sessionId,
        cols,
        rows,
        onEvent: channel,
      });
      const { id: terminalId, resizable } = await opening;
      // Preserve input ordering across IPC calls, including large pasted text.
      let pending = Promise.resolve();
      return {
        resizable,
        write: (data) => {
          const bytes =
            typeof data === "string"
              ? new TextEncoder().encode(data)
              : new Uint8Array(data);
          pending = pending.then(async () => {
            if (retired) throw new Error("Console is closed.");
            for (let offset = 0; offset < bytes.length; offset += 16384) {
              if (retired) throw new Error("Console is closed.");
              await invoke("terminal_input", {
                sessionId,
                terminalId,
                data: Array.from(bytes.subarray(offset, offset + 16384)),
              });
            }
          });
          return pending;
        },
        resize: (cols, rows) =>
          invoke("terminal_resize", { sessionId, terminalId, cols, rows }),
        close: () => {
          retired = true;
          return invoke("close_terminal", { sessionId, terminalId });
        },
      };
    },
  };
}
export const nativeServices = createNativeServices();
