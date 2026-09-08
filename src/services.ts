// SPDX-License-Identifier: MPL-2.0
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type {
  HostServices,
  HostKeyChallenge,
  Session,
  TerminalEvent,
  TransferProgress,
} from "./sdk";
export const native = isTauri();
export const nativeServices: HostServices = {
  systemClipboardSequence: () => invoke("system_clipboard_sequence"),
  pasteSystemFiles: (sessionId, parent) =>
    invoke("paste_system_files", { sessionId, parent }),
  cutToSystem: (sessionId, path, revision) =>
    invoke("cut_system_file", { sessionId, path, revision }),
  systemFileClipboard:
    native &&
    typeof navigator !== "undefined" &&
    /Windows/.test(navigator.userAgent),
  copyToSystem: (sessionId, files) =>
    invoke("copy_system_files", { sessionId, files }),
  chooseDownloads: (sessionId, files) =>
    invoke("choose_download_files", { sessionId, files }),
  prepareCopy: (sessionId, path, revision, parent) =>
    invoke("prepare_file_copy", { sessionId, path, revision, parent }),
  readHostSettings: (sessionId) => invoke("read_host_settings", { sessionId }),
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
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    const terminalId = await invoke<number>("open_terminal", {
      sessionId,
      cols,
      rows,
      onEvent: channel,
    });
    // Preserve input ordering across IPC calls, including large pasted text.
    let pending = Promise.resolve();
    return {
      write: (data) => {
        const bytes = new TextEncoder().encode(data);
        pending = pending.then(async () => {
          for (let offset = 0; offset < bytes.length; offset += 16384) {
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
      close: () => invoke("close_terminal", { sessionId, terminalId }),
    };
  },
};
