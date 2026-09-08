// SPDX-License-Identifier: MPL-2.0
import type { Capability, HostServices, Session, SessionServices } from "./sdk";

/** Lifetime and capability checks complement native ownership checks; not a sandbox. */
export function bindSession(backend: HostServices, session: Session | null) {
  let closed = false;
  let generation = 0;
  function check(capability: Capability, expected = generation) {
    if (closed || !session || expected !== generation)
      throw new Error("This host session is no longer connected");
    if (!session.info.capabilities.includes(capability))
      throw new Error(`Unavailable on this device: ${capability}`);
    return session.id;
  }
  const services: SessionServices = {
    readText: async (path) => {
      const expected = generation;
      const result = await backend.readText(check("files.read"), path);
      check("files.read", expected);
      return result;
    },
    saveText: async (path, text, revision) => {
      const expected = generation;
      const result = await backend.saveText(
        check("files.edit"),
        path,
        text,
        revision,
      );
      check("files.edit", expected);
      return result;
    },
    list: async (path) => {
      const expected = generation;
      const result = await backend.list(check("files.read"), path);
      check("files.read", expected);
      return result;
    },
    preview: async (path) => {
      const expected = generation;
      const result = await backend.preview(check("files.read"), path);
      check("files.read", expected);
      return result;
    },
    terminal: async (cols, rows, onEvent) => {
      const expected = generation;
      const handle = await backend.terminal(
        check("terminal"),
        cols,
        rows,
        (event) => {
          if (!closed && expected === generation) onEvent(event);
        },
      );
      if (closed || expected !== generation) {
        await handle.close();
        throw new Error("This host session is no longer connected");
      }
      return {
        write: async (data) => {
          check("terminal", expected);
          await handle.write(data);
        },
        resize: async (cols, rows) => {
          check("terminal", expected);
          await handle.resize(cols, rows);
        },
        close: () => handle.close(),
      };
    },
  };
  return {
    services,
    activate: () => {
      closed = false;
    },
    dispose: () => {
      closed = true;
      ++generation;
    },
  };
}
