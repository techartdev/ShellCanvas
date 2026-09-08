// SPDX-License-Identifier: MPL-2.0
import type {
  Capability,
  DesktopApp,
  SessionServices,
  TransferTicket,
} from "./sdk";
import { shareFileClipboard } from "./file-clipboard";
import { transferCapability } from "./sdk";

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
    systemClipboardSequence: guard(
      "files.read",
      base.systemClipboardSequence.bind(base),
    ),
    pasteSystemFiles: guard("files.upload", async (parent: string) => {
      const result = await base.pasteSystemFiles(parent);
      return result === null ? null : result.map(adopt);
    }),
    cutToSystem: guard("files.move", base.cutToSystem.bind(base)),
    systemFileClipboard:
      (declared.has("files.download") ||
        declared.has("files.upload") ||
        declared.has("files.move")) &&
      base.systemFileClipboard,
    copyToSystem: guard("files.download", base.copyToSystem.bind(base)),
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
    chooseUploads: guard("files.upload", async (parent: string) =>
      (await base.chooseUploads(parent)).map(adopt),
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
