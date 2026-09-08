// SPDX-License-Identifier: MPL-2.0
import { connectToShellCanvas } from "@shellcanvas/app-sdk";

const root = document.querySelector<HTMLDivElement>("#root")!;
root.innerHTML = `<main><p class="eyebrow">SHELLCANVAS · SAMPLE APP</p><h1>Field Notes</h1><p class="intro">A separately built app, using the desktop’s shared dialogs.</p><textarea aria-label="Notes" placeholder="Write a note for this workspace…"></textarea><div class="actions"><button id="message">Message box</button><button id="open">Browse files</button><button id="save">Save note as…</button><button id="denied">Check unavailable service</button></div><output aria-live="polite">Connecting to the desktop…</output></main>`;
const status = root.querySelector("output")!;
const localActions = document.createElement("div");
localActions.className = "actions";
localActions.innerHTML =
  '<button id="remember">Remember locally</button><button id="restore">Restore local note</button><button id="copy-note">Copy note</button><button id="paste-text">Paste text</button>';
status.before(localActions);
const buttons = [...root.querySelectorAll("button")];
buttons.forEach((button) => {
  button.disabled = true;
});
async function start() {
  try {
    const client = await connectToShellCanvas();
    const connectionState = document.createElement("p");
    connectionState.className = "intro";
    root.querySelector("textarea")!.before(connectionState);
    client.events.subscribe((batch) => {
      for (const event of batch.events) {
        if (event.topic !== "system.environment") continue;
        const state = event.value as { connection: string };
        connectionState.textContent =
          state.connection === "review-required"
            ? "A new connection is waiting for your approval."
            : state.connection === "disconnected"
              ? "Host disconnected. Your note is still here."
              : state.connection === "connected"
                ? "Workspace connected"
                : "Local workspace";
      }
    });
    let localRevision: string | null = null;
    let localAvailable = false;
    try {
      localRevision = (await client.storage.get("note"))?.revision ?? null;
      localAvailable = true;
    } catch {
      /* Older workbenches may only offer dialog services. */
    }
    let dirty = false;
    const available = await client.services.list();
    const canCopy = available.some(
      (method) =>
        method.name === "system.clipboard.writeStart" &&
        method.granted &&
        method.available,
    );
    const canPaste = available.some(
      (method) =>
        method.name === "system.clipboard.readStart" &&
        method.granted &&
        method.available,
    );
    const enabled = (button: HTMLButtonElement) =>
      button.id === "copy-note"
        ? canCopy
        : button.id === "paste-text"
          ? canPaste
          : ["remember", "restore"].includes(button.id)
            ? localAvailable
            : true;
    let busy = false;
    const publish = () => client.window.setDocumentState({ dirty, busy });
    root.querySelector("textarea")!.addEventListener("input", () => {
      dirty = true;
      void publish().catch((error) => {
        status.textContent = String(error);
      });
    });
    status.textContent =
      "Connected through the app API. No direct host or native access.";
    buttons.forEach((button) => {
      button.disabled = !enabled(button);
    });
    const run = async (operation: () => Promise<unknown>) => {
      busy = true;
      buttons.forEach((button) => {
        button.disabled = true;
      });
      try {
        await publish();
        status.textContent = JSON.stringify(await operation());
      } catch (error) {
        status.textContent =
          error instanceof Error ? error.message : String(error);
      } finally {
        busy = false;
        await publish().catch(() => {});
        buttons.forEach((button) => {
          button.disabled = !enabled(button);
        });
      }
    };
    root.querySelector("#message")!.addEventListener(
      "click",
      () =>
        void run(() =>
          client.system.dialogs.messageBox({
            title: "A note from Field Notes",
            message:
              "This dialog belongs to the desktop. The app only supplies its content.",
            buttons: [
              { id: "cancel", label: "Keep editing" },
              { id: "ok", label: "Looks good" },
            ],
            defaultId: "cancel",
            cancelId: "cancel",
          }),
        ),
    );
    root.querySelector("#open")!.addEventListener(
      "click",
      () =>
        void run(() =>
          client.system.dialogs.openFile({
            title: "Browse this workspace",
            multiple: true,
          }),
        ),
    );
    root.querySelector("#save")!.addEventListener(
      "click",
      () =>
        void run(async () => {
          const saved = await client.system.files.saveTextAs({
            name: "field-notes.txt",
            text: root.querySelector("textarea")!.value,
          });
          if (saved && saved.text === root.querySelector("textarea")!.value)
            dirty = false;
          return saved;
        }),
    );
    root
      .querySelector("#denied")!
      .addEventListener(
        "click",
        () => void run(() => client.call("system.private.credentials")),
      );
    root.querySelector("#remember")!.addEventListener(
      "click",
      () =>
        void run(async () => {
          const saved = await client.storage.put(
            "note",
            { format: 1, text: root.querySelector("textarea")!.value },
            localRevision,
          );
          localRevision = saved.revision;
          return "Remembered on this device. The remote file has not changed.";
        }),
    );
    root.querySelector("#restore")!.addEventListener(
      "click",
      () =>
        void run(async () => {
          const saved = await client.storage.get("note");
          if (!saved) {
            localRevision = null;
            return "No local note has been remembered yet.";
          }
          const value = saved.value;
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            value.format !== 1 ||
            typeof value.text !== "string"
          )
            throw new Error(
              "This saved note uses a different format. It has been preserved.",
            );
          if (
            dirty &&
            (await client.system.dialogs.messageBox({
              title: "Restore local note?",
              message:
                "Replace the note you are editing with the remembered copy?",
              buttons: [
                { id: "cancel", label: "Keep editing" },
                { id: "restore", label: "Restore note" },
              ],
              cancelId: "cancel",
              defaultId: "cancel",
            })) !== "restore"
          )
            return "Kept the current note.";
          root.querySelector("textarea")!.value = value.text;
          localRevision = saved.revision;
          dirty = true;
          return "Restored the note remembered on this device.";
        }),
    );
    root.querySelector("#copy-note")!.addEventListener(
      "click",
      () =>
        void run(async () => {
          await client.clipboard.writeText(
            root.querySelector("textarea")!.value,
          );
          return "Copied the note.";
        }),
    );
    root.querySelector("#paste-text")!.addEventListener(
      "click",
      () =>
        void run(async () => {
          const note = root.querySelector("textarea")!,
            previous = note.value,
            start = note.selectionStart,
            end = note.selectionEnd;
          const text = await client.clipboard.readText();
          if (note.value !== previous)
            throw new Error(
              "The note changed while reading the clipboard. Paste again when ready.",
            );
          note.setRangeText(text, start, end, "end");
          dirty = true;
          return "Pasted clipboard text.";
        }),
    );
    return client;
  } catch (error) {
    status.textContent = String(error);
  }
}
export const connection = start();
