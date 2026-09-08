// SPDX-License-Identifier: MPL-2.0
import { connectToShellCanvas } from "../../src/extensions/client";

const root = document.querySelector<HTMLDivElement>("#root")!;
root.innerHTML = `<main><p class="eyebrow">SHELLCANVAS · SAMPLE APP</p><h1>Field Notes</h1><p class="intro">A separately built app, using the desktop’s shared dialogs.</p><textarea aria-label="Notes" placeholder="Write a note for this workspace…"></textarea><div class="actions"><button id="message">Message box</button><button id="open">Browse files</button><button id="save">Save note as…</button><button id="denied">Check unavailable service</button></div><output aria-live="polite">Connecting to the desktop…</output></main>`;
const status = root.querySelector("output")!;
const buttons = [...root.querySelectorAll("button")];
buttons.forEach((button) => {
  button.disabled = true;
});
async function start() {
  try {
    const client = await connectToShellCanvas();
    status.textContent =
      "Connected through the app API. No direct host or native access.";
    buttons.forEach((button) => {
      button.disabled = false;
    });
    const run = async (operation: () => Promise<unknown>) => {
      buttons.forEach((button) => {
        button.disabled = true;
      });
      try {
        status.textContent = JSON.stringify(await operation());
      } catch (error) {
        status.textContent =
          error instanceof Error ? error.message : String(error);
      } finally {
        buttons.forEach((button) => {
          button.disabled = false;
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
        void run(() =>
          client.system.files.saveTextAs({
            name: "field-notes.txt",
            text: root.querySelector("textarea")!.value,
          }),
        ),
    );
    root
      .querySelector("#denied")!
      .addEventListener(
        "click",
        () => void run(() => client.call("system.private.credentials")),
      );
  } catch (error) {
    status.textContent = String(error);
  }
}
void start();
