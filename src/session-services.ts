// SPDX-License-Identifier: MPL-2.0
import type {
  Capability,
  HostServices,
  Session,
  SessionServices,
  TransferTicket,
} from "./sdk";
import {
  capabilityStatus,
  capabilityReason,
  capabilityLabels,
  capabilityOperationReason,
  transferCapability,
} from "./sdk";
import { notifyFileChanges, beginFileRelocation } from "./file-events";
import { fileClipboard } from "./file-clipboard";
import { RpcError } from "./extensions/rpc";

/** Lifetime and capability checks complement native ownership checks; not a sandbox. */
export function bindSession(
  backend: HostServices,
  session: Session | null,
  reportError: (message: string) => void = console.warn,
  options: { clipboardLifecycle?: boolean } = {},
) {
  if (session && backend.bindSources) backend = backend.bindSources(session);
  let closed = false;
  let generation = 0;
  let lifetimeEpoch = 0;
  let textChangedAt = 0;
  let currentSession = session;
  const acceptedSources = new Map(
    (Object.keys(capabilityLabels) as Capability[]).map((cap) => [
      cap,
      JSON.stringify(
        session ? (capabilityStatus(session, cap).source ?? null) : null,
      ),
    ]),
  );
  const changedAt = new Map<Capability, number>();
  const tickets = new Map<number, TransferTicket>();
  const customCalls = new Set<AbortController>();
  const clipboardPreparations = new Map<string, number>();
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
    if (
      closed ||
      !session ||
      expected < lifetimeEpoch ||
      expected < (changedAt.get(capability) ?? 0) ||
      JSON.stringify(
        currentSession
          ? (capabilityStatus(currentSession, capability).source ?? null)
          : null,
      ) !== acceptedSources.get(capability)
    )
      throw new Error("This host session is no longer connected");
    if (
      !currentSession ||
      capabilityStatus(currentSession, capability).state !== "available"
    )
      throw new Error(
        `Unavailable on this device: ${capability}. ${currentSession ? capabilityReason(currentSession, capability) : ""}`,
      );
    return session.id;
  }
  function valid(capability: Capability, expected: number) {
    try {
      check(capability, expected);
      return true;
    } catch {
      return false;
    }
  }
  function checkText(expected = generation) {
    const id = check("files.read", expected);
    if (expected < textChangedAt)
      throw new Error(
        "Text document access changed before the operation completed.",
      );
    const reason = capabilityOperationReason(
      currentSession!,
      "files.read",
      "readText",
    );
    if (reason) throw new RpcError("unavailable", reason);
    return id;
  }
  function mutationCompleted(
    capability: Capability,
    expected: number,
    relocate?: () => void,
  ) {
    try {
      check(capability, expected);
    } catch {
      throw new Error(
        "Connection changed before the operation was confirmed. The remote change may have completed; verify the destination before retrying.",
      );
    }
    relocate?.();
    notifyFileChanges(session!.id, relocate ? "relocation" : "content");
  }
  const services: SessionServices = {
    custom:
      backend.custom && session
        ? {
            async list(signal) {
              const epoch = lifetimeEpoch;
              if (closed) throw new RpcError("closed", "Workspace is closed");
              const result = await backend.custom!.list(session.id, signal);
              if (closed || epoch !== lifetimeEpoch)
                throw new RpcError("closed", "Workspace changed");
              return result;
            },
            async call(binding, method, params, signal) {
              const epoch = lifetimeEpoch;
              if (closed) throw new RpcError("closed", "Workspace is closed");
              const controller = new AbortController();
              const cancel = () => controller.abort();
              customCalls.add(controller);
              signal?.addEventListener("abort", cancel, { once: true });
              if (signal?.aborted) cancel();
              try {
                if (controller.signal.aborted)
                  throw new RpcError(
                    "aborted",
                    "Service call canceled before dispatch",
                  );
                const result = await backend.custom!.call(
                  session.id,
                  binding,
                  method,
                  params,
                  controller.signal,
                );
                if (closed || epoch !== lifetimeEpoch)
                  throw new RpcError(
                    "closed",
                    "Workspace changed; the remote outcome may be uncertain. Inspect before retrying.",
                  );
                if (controller.signal.aborted)
                  throw new RpcError(
                    "aborted",
                    "Service call canceled; dispatched effects may have occurred.",
                  );
                return result;
              } finally {
                signal?.removeEventListener("abort", cancel);
                customCalls.delete(controller);
              }
            },
          }
        : undefined,
    cancelClipboardPreparation: (operation) => {
      const owner = clipboardPreparations.get(operation);
      if (owner === undefined)
        throw new Error(
          "Clipboard preparation does not belong to this binding",
        );
      return backend.cancelClipboardPreparation(owner, operation);
    },
    systemClipboardSequence: async () => {
      const expected = generation;
      check("files.read");
      const result = await backend.systemClipboardSequence();
      check("files.read", expected);
      return result;
    },
    pasteSystemFiles: async (parent) => {
      const expected = generation;
      const result = await backend.pasteSystemFiles(
        check("files.upload"),
        parent,
      );
      const adopted = await adopt(result ?? [], expected, "files.upload");
      return result === null ? null : adopted;
    },
    cutToSystem: async (path, revision, preparation) => {
      const expected = generation;
      const owner = check("files.move");
      if (preparation && clipboardPreparations.has(preparation.id))
        throw new Error("Clipboard preparation is already active");
      if (preparation) clipboardPreparations.set(preparation.id, owner);
      try {
        const result = await backend.cutToSystem(
          owner,
          path,
          revision,
          preparation,
        );
        check("files.move", expected);
        return result;
      } finally {
        if (preparation) clipboardPreparations.delete(preparation.id);
      }
    },
    systemFileClipboard: backend.systemFileClipboard,
    copyToSystem: async (files, preparation) => {
      const expected = generation;
      const owner = check("files.download");
      if (preparation && clipboardPreparations.has(preparation.id))
        throw new Error("Clipboard preparation is already active");
      if (preparation) clipboardPreparations.set(preparation.id, owner);
      try {
        const result = await backend.copyToSystem(
          owner,
          files.map((file) => ({ ...file })),
          preparation,
        );
        check("files.download", expected);
        return result;
      } finally {
        if (preparation) clipboardPreparations.delete(preparation.id);
      }
    },
    prepareCopySelection: backend.prepareCopySelection
      ? async (files, parent) => {
          const expected = generation;
          const ticket = await backend.prepareCopySelection!(
            check("files.copy"),
            files.map((file) => ({ ...file })),
            parent,
          );
          return (await adopt([ticket], expected, "files.copy"))[0];
        }
      : undefined,
    chooseDownloads: async (files) => {
      const expected = generation;
      return adopt(
        await backend.chooseDownloads(
          check("files.download"),
          files.map((file) => ({ ...file })),
        ),
        expected,
        "files.download",
      );
    },
    prepareCopy: async (path, revision, parent) => {
      const expected = generation;
      return (
        await adopt(
          [
            await backend.prepareCopy(
              check("files.copy"),
              path,
              revision,
              parent,
            ),
          ],
          expected,
          "files.copy",
        )
      )[0];
    },
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
    chooseUploads: async (parent, folder) => {
      const expected = generation;
      return adopt(
        await backend.chooseUploads(check("files.upload"), parent, folder),
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
      const id = check(transferCapability(owned.direction));
      try {
        const result = await backend.runTransfer(id, ticket.id, (event) => {
          if (valid(transferCapability(owned.direction), expected))
            onProgress(event);
        });
        // Interrupted folders can contain successfully completed children.
        if (owned.direction !== "download")
          mutationCompleted(transferCapability(owned.direction), expected);
        if (
          result.status === "completed" &&
          owned.direction === "download" &&
          !valid("files.download", expected)
        )
          throw new Error(
            "The file service changed before the download was confirmed. Check the local destination before retrying.",
          );
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
      const follow = beginFileRelocation(
        id,
        fileClipboard(services).trackedPaths(),
      );
      try {
        const result = await backend.renameEntry(
          id,
          path,
          name,
          revision,
          follow.tracked,
        );
        mutationCompleted("files.manage", expected, () => {
          fileClipboard(services).relocated(result);
          follow.apply(result);
        });
        return result.path;
      } finally {
        follow.finish();
      }
    },
    removeEntry: async (path, revision) => {
      const expected = generation;
      await backend.removeEntry(check("files.manage"), path, revision);
      mutationCompleted("files.manage", expected);
      fileClipboard(services).removed(path);
    },
    moveEntry: async (path, parent, revision) => {
      const expected = generation;
      const id = check("files.move");
      const follow = beginFileRelocation(
        id,
        fileClipboard(services).trackedPaths(),
      );
      try {
        const result = await backend.moveEntry(
          id,
          path,
          parent,
          revision,
          follow.tracked,
        );
        mutationCompleted("files.move", expected, () => {
          fileClipboard(services).relocated(result);
          follow.apply(result);
        });
        return result.path;
      } finally {
        follow.finish();
      }
    },
    readText: async (path) => {
      const expected = generation;
      const result = await backend.readText(checkText(), path);
      checkText(expected);
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
          if (valid("terminal", expected)) return onEvent(event);
        },
      );
      if (!valid("terminal", expected)) {
        await handle.close();
        throw new Error("This host session is no longer connected");
      }
      return {
        resizable: handle.resizable,
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
    updateAvailability: (next: Session | null) => {
      if (!next || next.id !== session?.id) return;
      const textChanged =
        (currentSession
          ? capabilityOperationReason(
              currentSession,
              "files.read",
              "readText",
            ) === null
          : false) !==
        (capabilityOperationReason(next, "files.read", "readText") === null);
      const changes = (Object.keys(capabilityLabels) as Capability[]).filter(
        (cap) => {
          const before =
            currentSession && capabilityStatus(currentSession, cap);
          const after = capabilityStatus(next, cap);
          return (
            before?.state !== after.state ||
            JSON.stringify(before?.source ?? null) !==
              JSON.stringify(after.source ?? null)
          );
        },
      );
      currentSession = next;
      if (!changes.length && !textChanged) return;
      ++generation;
      if (textChanged) textChangedAt = generation;
      changes.forEach((cap) => changedAt.set(cap, generation));
      if (
        options.clipboardLifecycle !== false &&
        (changes.includes("files.move") || changes.includes("files.read"))
      ) {
        fileClipboard(services).dispose();
        if (valid("files.move", generation)) fileClipboard(services).activate();
      }
      for (const [id, ticket] of tickets) {
        const capability = transferCapability(ticket.direction);
        if (!changes.includes(capability)) continue;
        void backend
          .cancelTransfer(next.id, id)
          .catch((error) => reportError(`Transfer cleanup failed: ${error}`));
        tickets.delete(id);
      }
    },
    activate: () => {
      closed = false;
      if (options.clipboardLifecycle !== false)
        fileClipboard(services).activate();
    },
    dispose: () => {
      closed = true;
      for (const controller of customCalls) controller.abort();
      customCalls.clear();
      ++generation;
      lifetimeEpoch = generation;
      if (options.clipboardLifecycle !== false)
        fileClipboard(services).dispose();
      for (const id of tickets.keys())
        void backend
          .cancelTransfer(session!.id, id)
          .catch((error) => reportError(`Transfer cleanup failed: ${error}`));
      tickets.clear();
    },
  };
}
