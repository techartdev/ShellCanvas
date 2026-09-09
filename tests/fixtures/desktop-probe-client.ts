// SPDX-License-Identifier: MPL-2.0
// The real SDK example, with test-only controls for the opaque frame's DOM.
import { connection } from "../../examples/dialog-app/main";
import type {
  AppEnvironment,
  ServiceMethodInfo,
} from "../../src/extensions/environment-api";
const environmentEvents: AppEnvironment[] = [];
let capturedDocument:
  | Awaited<
      ReturnType<NonNullable<Awaited<typeof connection>>["files"]["readText"]>
    >
  | undefined;
let capturedListing:
  AsyncIterator<import("@shellcanvas/app-sdk").RemoteDirectoryPage> | undefined;
let watching = false;
let fileExportAbort: AbortController | undefined;
let fileExport: Promise<boolean> | undefined;
let transfer: import("@shellcanvas/app-sdk").RemoteTransfer | undefined;
let transferRunning:
  Promise<import("@shellcanvas/app-sdk").TransferResult> | undefined;
let lateChooserAbort: AbortController | undefined;
let lateChooser: Promise<boolean> | undefined;
let capturedSetting:
  import("@shellcanvas/app-sdk").RemoteHostSetting | undefined;
let settingsAbort: AbortController | undefined;
let pendingSetting: Promise<boolean> | undefined;
let capturedEntry:
  import("@shellcanvas/app-sdk").RemoteEntryLocation | undefined;
window.addEventListener("message", async (event) => {
  if (event.source !== parent || event.data?.type !== "desktop-probe") return;
  const note = document.querySelector<HTMLTextAreaElement>("textarea")!;
  if (event.data.action === "edit") {
    note.value = "A draft kept across package updates.";
    note.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (event.data.action === "message")
    document.querySelector<HTMLButtonElement>("#message")!.click();
  if (event.data.action === "browse")
    document.querySelector<HTMLButtonElement>("#open")!.click();
  if (event.data.action === "remember" || event.data.action === "restore")
    document.querySelector<HTMLButtonElement>(`#${event.data.action}`)!.click();
  let storage: unknown;
  let files: Record<string, boolean> | undefined;
  let transfers: Record<string, boolean> | undefined;
  let hostSettings: Record<string, boolean> | undefined;
  let windowState: import("@shellcanvas/app-sdk").AppWindowState | undefined;
  let windowError: string | undefined;
  let imageClipboard: Record<string, boolean> | undefined;
  let fileClipboard: Record<string, boolean> | undefined;
  if (event.data.action === "file-shared-paste") {
    const client = (await connection)!;
    const binding = (await client.environment.get()).binding!;
    const jobs = await client.clipboard.pasteFiles({
      binding,
      path: "fixture:shared-target",
    });
    const result = await jobs[0].run();
    await jobs[0].close();
    fileClipboard = {
      completed:
        jobs.length === 1 &&
        jobs[0].direction === "copy" &&
        result.status === "completed" &&
        result.destination?.path === "fixture:shared-copied",
    };
  }
  if (event.data.action === "file-copy-start") {
    const client = (await connection)!;
    const binding = (await client.environment.get()).binding!;
    fileExportAbort = new AbortController();
    fileExport = client.clipboard
      .copyFiles(
        [{ binding, path: "fixture:held-export", revision: "export-1" }],
        fileExportAbort.signal,
      )
      .then(
        () => false,
        (error) => error.code === "aborted",
      );
    await client.window.setDocumentState({ dirty: false, busy: false });
    fileClipboard = { started: true };
  }
  if (event.data.action === "file-copy-cancel") {
    fileExportAbort!.abort();
    fileClipboard = { canceled: await fileExport! };
    await (await connection)!.window.setDocumentState({
      dirty: false,
      busy: false,
    });
  }
  if (event.data.action === "file-copy") {
    const client = (await connection)!;
    const binding = (await client.environment.get()).binding!;
    await client.clipboard.copyFiles(
      Array.from({ length: 300 }, (_, i) => ({
        binding,
        path: `fixture:export-${i}`,
        revision: "export-1",
      })),
    );
    fileClipboard = { published: true };
  }
  if (event.data.action === "file-copy-denied") {
    const client = (await connection)!;
    const binding = (await client.environment.get()).binding!;
    try {
      await client.clipboard.copyFiles([
        { binding, path: "fixture:export-0", revision: "export-1" },
      ]);
      fileClipboard = { denied: false };
    } catch (error) {
      fileClipboard = { denied: (error as { code: string }).code === "denied" };
    }
  }
  if (event.data.action === "file-clipboard") {
    const client = (await connection)!;
    const binding = (await client.environment.get()).binding!;
    const jobs = await client.clipboard.pasteFiles({
      binding,
      path: "fixture:clipboard-target",
    });
    const queued =
      jobs.length === 1 && (await jobs[0].status()).state === "queued";
    const result = await jobs[0].run();
    await jobs[0].close();
    fileClipboard = {
      queued,
      completed:
        result.status === "completed" &&
        result.destination?.binding === binding &&
        result.destination?.path === "fixture:uploaded",
    };
  }
  if (event.data.action === "file-clipboard-denied") {
    const client = (await connection)!;
    const binding = (await client.environment.get()).binding!;
    try {
      await client.clipboard.pasteFiles({
        binding,
        path: "fixture:clipboard-target",
      });
      fileClipboard = { denied: false };
    } catch (error) {
      fileClipboard = { denied: (error as { code: string }).code === "denied" };
    }
  }
  if (event.data.action === "image-clipboard") {
    const client = (await connection)!;
    const expected = {
      width: 256,
      height: 129,
      rgba: Uint8Array.from({ length: 256 * 129 * 4 }, (_, i) => i % 256),
    };
    await client.clipboard.writeImage(expected);
    const read = await client.clipboard.readImage();
    imageClipboard = {
      metadata:
        read.width === expected.width && read.height === expected.height,
      pixels:
        read.rgba.length === expected.rgba.length &&
        read.rgba.every((byte, i) => byte === expected.rgba[i]),
    };
  }
  if (event.data.action === "image-clipboard-denied") {
    try {
      await (await connection)!.clipboard.readImage();
      imageClipboard = { denied: false };
    } catch (error) {
      imageClipboard = {
        denied: (error as { code: string }).code === "denied",
      };
    }
  }
  if (event.data.action.startsWith("window-")) {
    const client = (await connection)!;
    try {
      const action = event.data.action.slice(7);
      if (action === "clean-close") {
        await client.window.setDocumentState({ dirty: false, busy: false });
        void client.window.requestClose().catch(() => {});
        return; // The host observes frame retirement; no reply from a destroyed app is required.
      }
      if (action !== "state") {
        const commands = {
          focus: client.window.focus,
          minimize: client.window.minimize,
          maximize: client.window.maximize,
          restore: client.window.restore,
          close: client.window.requestClose,
        };
        await commands[action as keyof typeof commands]();
      }
      windowState = await client.window.getState();
    } catch (error) {
      windowError = (error as { code: string }).code;
    }
  }
  if (event.data.action.startsWith("host-settings")) {
    try {
      const client = (await connection)!;
      const binding = (await client.environment.get()).binding!;
      switch (event.data.action) {
        case "host-settings": {
          const fields = await client.hostSettings.read({ binding });
          capturedSetting = fields[0];
          const updated = await client.hostSettings.apply(
            capturedSetting,
            "quiet",
          );
          let conflict = false;
          try {
            await client.hostSettings.apply(capturedSetting, "normal");
          } catch (error) {
            conflict = (error as { code: string }).code === "failed";
          }
          hostSettings = {
            conflict,
            metadata:
              fields[0].id === "fixture:mode" &&
              fields[0].choices.includes("quiet") &&
              fields[1].writable === false &&
              fields[1].reason === "Unsupported on this device",
            updated:
              updated.value === "quiet" &&
              updated.revision === "h2" &&
              updated.binding === binding,
          };
          break;
        }
        case "host-settings-start": {
          const [field] = await client.hostSettings.read({ binding });
          settingsAbort = new AbortController();
          pendingSetting = client.hostSettings
            .apply(field, "held", settingsAbort.signal)
            .then(
              () => false,
              (error) => error.code === "aborted",
            );
          await client.window.setDocumentState({ dirty: false, busy: false });
          hostSettings = { started: true };
          break;
        }
        case "host-settings-cancel":
          settingsAbort!.abort();
          hostSettings = { aborted: await pendingSetting! };
          await client.window.setDocumentState({ dirty: false, busy: false });
          break;
        case "host-settings-refresh": {
          const [field] = await client.hostSettings.read({ binding });
          hostSettings = {
            updated: field.value === "held" && field.revision === "h3",
          };
          break;
        }
        case "host-settings-stale":
          try {
            await client.hostSettings.apply(capturedSetting!, "normal");
            hostSettings = { rejected: false };
          } catch (error) {
            hostSettings = {
              rejected: (error as { code: string }).code === "closed",
            };
          }
          break;
        case "host-settings-readonly": {
          const [field] = await client.hostSettings.read({ binding });
          let denied = false;
          try {
            await client.hostSettings.apply(field, "normal");
          } catch (error) {
            denied = (error as { code: string }).code === "denied";
          }
          hostSettings = { read: field.value === "held", denied };
          break;
        }
      }
    } catch {
      hostSettings = { failed: false };
    }
  }
  if (event.data.action.startsWith("transfer-")) {
    try {
      const client = (await connection)!;
      const binding = (await client.environment.get()).binding!;
      const entry = {
        binding,
        path: "fixture:transfer",
        revision: "transfer-1",
      };
      const destination = { binding, path: "fixture:destination" };
      switch (event.data.action) {
        case "transfer-late-prepare":
          lateChooserAbort = new AbortController();
          lateChooser = client.transfers
            .upload(
              { binding, path: "fixture:late-chooser" },
              {},
              lateChooserAbort.signal,
            )
            .then(
              () => false,
              (error) => error.code === "aborted",
            );
          transfers = { started: true };
          break;
        case "transfer-late-cancel":
          lateChooserAbort!.abort();
          transfers = { aborted: await lateChooser! };
          break;
        case "transfer-prepare":
          transfer = await client.transfers.copy(entry, destination);
          await client.window.setDocumentState({ dirty: false, busy: false });
          transfers = {
            prepared: (await transfer.status()).state === "queued",
            nativeIdHidden: !("id" in transfer),
          };
          break;
        case "transfer-run":
          transferRunning = transfer!.run();
          transfers = { started: true };
          break;
        case "transfer-release":
          await transfer!.close();
          transfers = { released: true };
          break;
        case "transfer-cancel":
          await transfer!.cancel();
          await client.window.setDocumentState({ dirty: false, busy: false });
          transfers = {
            waiting: (await transfer!.status()).state === "canceling",
          };
          break;
        case "transfer-finish": {
          const result = await transferRunning!;
          transfers = {
            completed: result.status === "completed",
            destination:
              result.destination?.binding === binding &&
              result.destination.path === "fixture:copied",
          };
          await transfer!.close();
          break;
        }
        case "transfer-roundtrip": {
          const uploaded = await client.transfers.upload(destination, {
            folder: true,
          });
          const downloaded = await client.transfers.download(entry);
          const batch = await client.transfers.downloadMany([
            entry,
            { ...entry, path: "fixture:second" },
          ]);
          let complete = true,
            privatePaths = true;
          for (const job of [...uploaded, downloaded!, ...batch]) {
            const result = await job.run();
            complete &&= result.status === "completed";
            if (job.direction === "download")
              privatePaths &&=
                !JSON.stringify(result).includes("private-local-path") &&
                !result.destination;
            await job.close();
          }
          transfers = {
            complete,
            privatePaths,
            folder: uploaded.length === 1,
            batch: batch.length === 2,
          };
          break;
        }
        case "transfer-denied":
          await client.transfers.copy(entry, destination);
          transfers = { denied: false };
          break;
      }
    } catch (error) {
      transfers = {
        denied:
          event.data.action === "transfer-denied" &&
          (error as { code: string }).code === "denied",
      };
    }
  }
  if (event.data.action === "files") {
    const client = (await connection)!;
    const binding = (await client.environment.get()).binding!;
    capturedDocument = await client.files.readText({
      binding,
      path: "fixture:note",
    });
    const saved = await client.files.saveText(
      capturedDocument,
      "Remote note ✓",
    );
    let conflict = false;
    try {
      await client.files.saveText(capturedDocument, "stale");
    } catch {
      conflict = true;
    }
    const created = await client.files.createText({
      binding,
      parent: "fixture:root",
      name: "new.txt",
      text: "Created 🌿",
    });
    const entryIn = async (path: string, name: string) => {
      for await (const page of client.files.list({ binding, path })) {
        const entry = page.entries.find((item) => item.name === name);
        if (entry?.revision)
          return {
            binding: page.binding,
            path: entry.path,
            revision: entry.revision,
          };
      }
      throw new Error(`Missing action entry: ${name}`);
    };
    capturedEntry = await entryIn("fixture:actions", "original.txt");
    const folder = await client.files.makeDirectory({
      binding,
      parent: "fixture:actions",
      name: "Folder",
    });
    let collision = false;
    try {
      await client.files.makeDirectory({
        binding,
        parent: "fixture:actions",
        name: "Folder",
      });
    } catch {
      collision = true;
    }
    const renamed = await client.files.renameEntry(
      capturedEntry,
      "renamed.txt",
    );
    const refreshed = await entryIn("fixture:actions", "renamed.txt");
    const moved = await client.files.moveEntry(refreshed, folder);
    const movedEntry = await entryIn(folder.path, "renamed.txt");
    await client.files.removeEntry(movedEntry);
    await client.files.removeEntry(await entryIn("fixture:actions", "Folder"));
    const paths: string[] = [];
    let pages = 0;
    for await (const page of client.files.list({
      binding,
      path: "fixture:many",
    })) {
      pages++;
      paths.push(...page.entries.map((entry) => entry.path));
    }
    capturedListing = client.files
      .list({ binding, path: "fixture:many" })
      [Symbol.asyncIterator]();
    await capturedListing.next();
    files = {
      read: capturedDocument.text === "Original note",
      saved:
        saved.text === "Remote note ✓" &&
        saved.revision !== capturedDocument.revision,
      conflict,
      created: created.text === "Created 🌿",
      actions:
        collision &&
        renamed.path === "fixture:renamed" &&
        moved.path === "fixture:moved",
      listed:
        pages === 3 &&
        paths.length === 257 &&
        new Set(paths).size === 257 &&
        paths[256] === "fixture:item:256",
    };
  }
  if (
    event.data.action === "files-stale" ||
    event.data.action === "files-denied"
  ) {
    const client = (await connection)!;
    try {
      if (event.data.action === "files-stale")
        await client.files.saveText(capturedDocument!, "Wrong host");
      else
        await client.files.readText({
          binding: (await client.environment.get()).binding!,
          path: "fixture:note",
        });
      files = { rejected: false };
    } catch (error) {
      files = {
        rejected:
          (error as { code: string }).code ===
          (event.data.action === "files-stale" ? "closed" : "denied"),
      };
    }
    try {
      if (event.data.action === "files-stale") await capturedListing!.next();
      else
        await client.files
          .list({ binding: (await client.environment.get()).binding! })
          [Symbol.asyncIterator]()
          .next();
      files.listingRejected = false;
    } catch (error) {
      files.listingRejected =
        (error as { code: string }).code ===
        (event.data.action === "files-stale" ? "closed" : "denied");
    }
    try {
      await client.files.removeEntry(
        capturedEntry ?? {
          binding: (await client.environment.get()).binding!,
          path: "fixture:entry",
          revision: "entry-1",
        },
      );
      files.actionRejected = false;
    } catch (error) {
      files.actionRejected =
        (error as { code: string }).code ===
        (event.data.action === "files-stale" ? "closed" : "denied");
    }
  }
  let clipboard: Record<string, boolean> | undefined;
  if (event.data.action === "clipboard") {
    const client = (await connection)!;
    const original = await client.clipboard.readText();
    const large = "x".repeat(65535) + "🌿" + "\u0001".repeat(800000);
    await client.clipboard.writeText(large);
    clipboard = {
      read: original === "Fixture clipboard",
      roundtrip: (await client.clipboard.readText()) === large,
    };
    await client.clipboard.writeText("");
    clipboard.empty = (await client.clipboard.readText()) === "";
  }
  if (event.data.action === "clipboard-denied") {
    try {
      await (await connection)!.clipboard.readText();
      clipboard = { denied: false };
    } catch (error) {
      clipboard = { denied: (error as { code: string }).code === "denied" };
    }
  }
  let environment: AppEnvironment | undefined,
    services: readonly ServiceMethodInfo[] | undefined;
  if (event.data.action === "environment" || event.data.action === "watch") {
    const client = (await connection)!;
    if (event.data.action === "watch" && !watching) {
      watching = true;
      client.events.subscribe((batch) => {
        for (const event of batch.events)
          if (event.topic === "system.environment")
            environmentEvents.push(event.value as unknown as AppEnvironment);
      });
    }
    environment = await client.environment.get();
    services = await client.services.list();
  }
  if (event.data.action === "storage") {
    try {
      const client = (await connection)!;
      const saved = await client.storage.put(
        "sdk-note",
        { text: "A local note" },
        null,
      );
      const read = await client.storage.get("sdk-note");
      await client.settings.put("sdk-note", { wrap: true }, null);
      const setting = await client.settings.get("sdk-note");
      const page = await client.storage.list({ after: undefined, limit: 1 });
      const keys = [...page.keys];
      let after = page.next;
      while (after) {
        const next = await client.storage.list({ after, limit: 1 });
        keys.push(...next.keys);
        after = next.next;
      }
      let conflict = false;
      try {
        await client.storage.put("sdk-note", "stale", null);
      } catch (error) {
        conflict = (error as { code: string }).code === "busy";
      }
      await client.storage.remove("sdk-note", saved.revision);
      await client.settings.remove("sdk-note", setting!.revision);
      storage = {
        roundtrip: JSON.stringify(read?.value) === JSON.stringify(saved.value),
        separate: JSON.stringify(setting?.value) === '{"wrap":true}',
        listed: keys.includes("sdk-note"),
        conflict,
        removed: (await client.storage.get("sdk-note")) === null,
      };
    } catch (error) {
      storage = { error: String(error) };
    }
  }
  parent.postMessage(
    {
      type: "desktop-probe-result",
      request: event.data.request,
      text: note.value,
      status: document.querySelector("output")!.textContent,
      ready: !document.querySelector<HTMLButtonElement>("#message")!.disabled,
      openNoteEnabled:
        !document.querySelector<HTMLButtonElement>("#open-note")!.disabled,
      storage,
      files,
      transfers,
      hostSettings,
      windowState,
      windowError,
      imageClipboard,
      fileClipboard,
      clipboard,
      environment,
      services,
      environmentEvents,
    },
    "*",
  );
});
