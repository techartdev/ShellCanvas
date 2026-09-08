// SPDX-License-Identifier: MPL-2.0
// The real SDK example, with test-only controls for the opaque frame's DOM.
import { connection } from "../../examples/dialog-app/main";
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
    },
    "*",
  );
});
