// SPDX-License-Identifier: MPL-2.0
import type {
  Capability,
  HostServices,
  Session,
  SessionServices,
  TransferTicket,
} from "./sdk";
import { notifyFileChanges, beginFileRelocation } from "./file-events";

/** Lifetime and capability checks complement native ownership checks; not a sandbox. */
export function bindSession(
  backend: HostServices,
  session: Session | null,
  reportError: (message: string) => void = console.warn,
) {
  let closed = false;
  let generation = 0;
  const tickets = new Map<number, TransferTicket>();
  async function adopt(
    result: TransferTicket[],
    expected: number,
    cap: Capability,
  ) {
    try {
      check(cap, expected);
    } catch (error) {
      await Promise.all(
        result.map((ticket) => backend.cancelTransfer(session!.id, ticket.id)),
      );
      throw error;
    }
    result.forEach((ticket) => tickets.set(ticket.id, ticket));
    return result;
  }
  function check(capability: Capability, expected = generation) {
    if (closed || !session || expected !== generation)
      throw new Error("This host session is no longer connected");
    if (!session.info.capabilities.includes(capability))
      throw new Error(`Unavailable on this device: ${capability}`);
    return session.id;
  }
  function mutationCompleted(capability: Capability, expected: number) {
    try {
      check(capability, expected);
    } catch {
      throw new Error(
        "Connection changed before the operation was confirmed. The remote change may have completed; verify the destination before retrying.",
      );
    }
    notifyFileChanges(session!.id);
  }
  const services: SessionServices = {
    readHostSettings: async () => {
      const expected = generation;
      const result = await backend.readHostSettings(check("host.settings"));
      check("host.settings", expected);
      return result;
    },
    applyHostSetting: async (id, value, revision) => {
      const expected = generation;
      const result = await backend.applyHostSetting(
        check("host.settings"),
        id,
        value,
        revision,
      );
      try {
        check("host.settings", expected);
      } catch {
        throw new Error(
          "The connection changed before the setting was confirmed. It may have been applied; reconnect and refresh before retrying.",
        );
      }
      return result;
    },
    chooseUploads: async (parent) => {
      const expected = generation;
      return adopt(
        await backend.chooseUploads(check("files.upload"), parent),
        expected,
        "files.upload",
      );
    },
    chooseDownload: async (path, revision) => {
      const expected = generation;
      const result = await backend.chooseDownload(
        check("files.download"),
        path,
        revision,
      );
      return (
        (await adopt(result ? [result] : [], expected, "files.download"))[0] ??
        null
      );
    },
    runTransfer: async (ticket, onProgress) => {
      const owned = tickets.get(ticket.id);
      if (!owned) throw new Error("Transfer does not belong to this workspace");
      const expected = generation;
      const id = check(
        owned.direction === "upload" ? "files.upload" : "files.download",
      );
      try {
        const result = await backend.runTransfer(id, ticket.id, (event) => {
          if (!closed && generation === expected) onProgress(event);
        });
        if (result.status === "completed" && owned.direction === "upload")
          mutationCompleted("files.upload", expected);
        return result;
      } finally {
        tickets.delete(ticket.id);
      }
    },
    cancelTransfer: async (id) => {
      if (!tickets.has(id) || !session) return;
      await backend.cancelTransfer(session.id, id);
      tickets.delete(id);
    },
    createText: async (parent, name, text) => {
      const expected = generation;
      const result = await backend.createText(
        check("files.create"),
        parent,
        name,
        text,
      );
      mutationCompleted("files.create", expected);
      return result;
    },
    makeDirectory: async (parent, name) => {
      const expected = generation;
      const result = await backend.makeDirectory(
        check("files.manage"),
        parent,
        name,
      );
      mutationCompleted("files.manage", expected);
      return result;
    },
    renameEntry: async (path, name, revision) => {
      const expected = generation;
      const id = check("files.manage");
      const follow = beginFileRelocation(id);
      try {
        const result = await backend.renameEntry(
          id,
          path,
          name,
          revision,
          follow.tracked,
        );
        mutationCompleted("files.manage", expected);
        follow.apply(result);
        return result.path;
      } finally {
        follow.finish();
      }
    },
    removeEntry: async (path, revision) => {
      const expected = generation;
      await backend.removeEntry(check("files.manage"), path, revision);
      mutationCompleted("files.manage", expected);
    },
    moveEntry: async (path, parent, revision) => {
      const expected = generation;
      const id = check("files.move");
      const follow = beginFileRelocation(id);
      try {
        const result = await backend.moveEntry(
          id,
          path,
          parent,
          revision,
          follow.tracked,
        );
        mutationCompleted("files.move", expected);
        follow.apply(result);
        return result.path;
      } finally {
        follow.finish();
      }
    },
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
      mutationCompleted("files.edit", expected);
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
      for (const id of tickets.keys())
        void backend
          .cancelTransfer(session!.id, id)
          .catch((error) => reportError(`Transfer cleanup failed: ${error}`));
      tickets.clear();
    },
  };
}
