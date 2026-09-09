// SPDX-License-Identifier: MPL-2.0
import type {
  Capability,
  DesktopApp,
  SessionServices,
  TransferTicket,
} from "./sdk";
import { shareFileClipboard } from "./file-clipboard";
import { transferCapability } from "./sdk";
import { RpcError } from "./extensions/rpc";

const scopes = new WeakMap<
  SessionServices,
  WeakMap<DesktopApp, SessionServices>
>();

/** Declared access for trusted bundled apps; native extension isolation is separate. */
export function scopeAppServices(
  base: SessionServices,
  app: DesktopApp,
): SessionServices {
  let group = scopes.get(base);
  if (!group) {
    group = new WeakMap();
    scopes.set(base, group);
  }
  const existing = group.get(app);
  if (existing) return existing;
  const declared = new Set<Capability>(
    app.scope === "host" ? [...app.requires, ...(app.optional ?? [])] : [],
  );
  const tickets = new Map<number, Readonly<TransferTicket>>();
  const preparations = new Set<string>();
  function check(capability: Capability) {
    if (!declared.has(capability))
      throw new Error(
        `App "${app.id}" did not declare capability: ${capability}`,
      );
  }
  function guard<A extends unknown[], R>(
    capability: Capability,
    run: (...args: A) => Promise<R>,
  ) {
    return async (...args: A) => {
      check(capability);
      return run(...args);
    };
  }
  function adopt(ticket: TransferTicket) {
    tickets.set(ticket.id, Object.freeze({ ...ticket }));
    return { ...ticket };
  }
  const services: SessionServices = {
    custom: base.custom
      ? {
          list: (signal) => base.custom!.list(signal),
          async call(binding, method, params, signal) {
            const item = (await base.custom!.list(signal)).find(
              (item) => item.name === method && item.binding === binding,
            );
            if (
              !item ||
              !app.customPermissions?.includes(`services.${item.service}`)
            )
              throw new RpcError(
                "denied",
                "This app did not declare the required custom service grant",
              );
            return base.custom!.call(binding, method, params, signal);
          },
        }
      : undefined,
    cancelClipboardPreparation: async (operation) => {
      if (!preparations.has(operation))
        throw new Error("Clipboard preparation does not belong to this app");
      await base.cancelClipboardPreparation(operation);
    },
    systemClipboardSequence: guard(
      "files.read",
      base.systemClipboardSequence.bind(base),
    ),
    inspectSystemFiles: base.inspectSystemFiles?.bind(base),
    pasteCopiedFiles: base.pasteCopiedFiles
      ? guard("files.copy", async (parent: string, sequence: number) =>
          (await base.pasteCopiedFiles!(parent, sequence)).map(adopt),
        )
      : undefined,
    pasteSystemFiles: guard(
      "files.upload",
      async (parent: string, sequence?: number) => {
        const result = await base.pasteSystemFiles(parent, sequence);
        return result === null ? null : result.map(adopt);
      },
    ),
    prepareCopySelection: base.prepareCopySelection
      ? guard(
          "files.copy",
          async (
            ...args: Parameters<
              NonNullable<SessionServices["prepareCopySelection"]>
            >
          ) => adopt(await base.prepareCopySelection!(...args)),
        )
      : undefined,
    cutToSystem: guard(
      "files.move",
      async (...args: Parameters<SessionServices["cutToSystem"]>) => {
        const id = args[2]?.id;
        if (id) preparations.add(id);
        try {
          return await base.cutToSystem(...args);
        } finally {
          if (id) preparations.delete(id);
        }
      },
    ),
    systemFileClipboard:
      (declared.has("files.download") ||
        declared.has("files.copy") ||
        declared.has("files.upload") ||
        declared.has("files.move")) &&
      base.systemFileClipboard,
    copyToSystem: guard(
      "files.download",
      async (...args: Parameters<SessionServices["copyToSystem"]>) => {
        const id = args[1]?.id;
        if (id) preparations.add(id);
        try {
          return await base.copyToSystem(...args);
        } finally {
          if (id) preparations.delete(id);
        }
      },
    ),
    chooseDownloads: guard(
      "files.download",
      async (files: { path: string; revision: string }[]) =>
        (await base.chooseDownloads(files)).map(adopt),
    ),
    prepareCopy: guard(
      "files.copy",
      async (path: string, revision: string, parent: string) =>
        adopt(await base.prepareCopy(path, revision, parent)),
    ),
    list: guard("files.read", base.list.bind(base)),
    preview: guard("files.read", base.preview.bind(base)),
    readText: guard("files.read", base.readText.bind(base)),
    saveText: guard("files.edit", base.saveText.bind(base)),
    createText: guard("files.create", base.createText.bind(base)),
    makeDirectory: guard("files.manage", base.makeDirectory.bind(base)),
    renameEntry: guard("files.manage", base.renameEntry.bind(base)),
    removeEntry: guard("files.manage", base.removeEntry.bind(base)),
    moveEntry: guard("files.move", base.moveEntry.bind(base)),
    terminal: guard("terminal", base.terminal.bind(base)),
    readHostSettings: guard("host.settings", base.readHostSettings.bind(base)),
    applyHostSetting: guard("host.settings", base.applyHostSetting.bind(base)),
    chooseUploads: guard(
      "files.upload",
      async (parent: string, folder?: boolean) =>
        (await base.chooseUploads(parent, folder)).map(adopt),
    ),
    chooseDownload: guard(
      "files.download",
      async (path: string, revision: string) => {
        const ticket = await base.chooseDownload(path, revision);
        return ticket ? adopt(ticket) : null;
      },
    ),
    runTransfer: async (ticket, onProgress) => {
      const owned = tickets.get(ticket.id);
      if (!owned) throw new Error("Transfer does not belong to this app");
      check(transferCapability(owned.direction));
      try {
        return await base.runTransfer({ ...owned }, onProgress);
      } finally {
        tickets.delete(owned.id);
      }
    },
    cancelTransfer: async (id) => {
      // Idempotent cleanup; never forward another app's ticket.
      if (!tickets.has(id)) return;
      await base.cancelTransfer(id);
      tickets.delete(id);
    },
  };
  // The workspace owns this clipboard's lifetime. Only move-capable scopes share it.
  if (declared.has("files.move")) shareFileClipboard(base, services);
  Object.freeze(services);
  group.set(app, services);
  return services;
}
