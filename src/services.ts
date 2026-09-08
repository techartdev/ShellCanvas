// SPDX-License-Identifier: MPL-2.0
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { HostServices, TerminalEvent } from "./sdk";
export const native = isTauri();
export const nativeServices: HostServices = {
  profiles: () => invoke("profiles"),
  saveProfile: (profile) => invoke("save_profile", { profile }),
  removeProfile: (id) => invoke("remove_profile", { id }),
  connect: (options) => invoke("connect", { options }),
  disconnect: (sessionId) => invoke("disconnect", { sessionId }),
  alive: (sessionId) => invoke("session_alive", { sessionId }),
  list: (sessionId, path) => invoke("list_directory", { sessionId, path }),
  preview: (sessionId, path) => invoke("preview_file", { sessionId, path }),
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
