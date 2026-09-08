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
      storage,
      files,
      clipboard,
      environment,
      services,
      environmentEvents,
    },
    "*",
  );
});
