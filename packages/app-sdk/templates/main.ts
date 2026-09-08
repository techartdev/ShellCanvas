// SPDX-License-Identifier: MPL-2.0
import {
  connectToShellCanvas,
  RpcError,
  type AppValue,
} from "@shellcanvas/app-sdk";

const root = document.querySelector<HTMLDivElement>("#root")!;
root.innerHTML = `<main><header><p class="eyebrow">YOUR WORKSPACE · YOUR IDEAS</p><h1></h1><p>A small notebook using the desktop’s shared services.</p></header><label for="note">Your note</label><textarea id="note" placeholder="Start with an idea…"></textarea><div class="actions"><button id="message">Message box</button><button id="browse">Browse files</button><button id="save">Save as…</button><button id="remember">Remember locally</button></div><output role="status">Connecting to ShellCanvas…</output></main>`;
root.querySelector("h1")!.textContent = __APP_TITLE__;
const note = root.querySelector<HTMLTextAreaElement>("textarea")!;
const status = root.querySelector("output")!;
const buttons = Array.from(root.querySelectorAll("button"));
buttons.forEach((button) => {
  button.disabled = true;
});

async function start() {
  const client = await connectToShellCanvas();
  let dirty = false,
    busy = false,
    stored: AppValue | null = null;
  const capabilities = new Map(
    (await client.services.list()).map((method) => [method.name, method]),
  );
  const supported = (method: string) => {
    const value = capabilities.get(method);
    return !!value?.granted && value.available;
  };
  const state = () => client.window.setDocumentState({ dirty, busy });
  const failed = (error: unknown) => {
    status.textContent =
      error instanceof RpcError
        ? `${error.code}: ${error.message}`
        : String(error);
  };
  note.addEventListener("input", () => {
    dirty = true;
    void state().catch(failed);
  });
  const action = (id: string, method: string, run: () => Promise<void>) => {
    const button = root.querySelector<HTMLButtonElement>(`#${id}`)!;
    const update = () => {
      button.disabled = busy || !supported(method);
    };
    button.addEventListener("click", () => {
      if (busy) return;
      busy = true;
      refresh();
      void (async () => {
        try {
          await state();
          await run();
        } catch (error) {
          failed(error);
        } finally {
          busy = false;
          refresh();
          await state().catch(failed);
        }
      })();
    });
    return update;
  };
  const updates = [
    action("message", "system.dialogs.messageBox", async () => {
      await client.system.dialogs.messageBox({
        title: "Hello from your app",
        message:
          "This dialog belongs to the desktop. Your app receives the result.",
      });
      status.textContent = "Dialog closed.";
    }),
    action("browse", "system.dialogs.openFile", async () => {
      const selected = await client.system.dialogs.openFile();
      status.textContent = selected?.length
        ? `Selected ${selected[0].name}`
        : "Selection canceled.";
    }),
    action("save", "system.files.saveTextAs", async () => {
      const snapshot = note.value;
      const saved = await client.system.files.saveTextAs({
        name: "note.txt",
        text: snapshot,
      });
      if (saved && note.value === snapshot) dirty = false;
      status.textContent = saved ? `Saved ${saved.name}` : "Save canceled.";
    }),
    action("remember", "system.storage.put", async () => {
      const snapshot = note.value;
      stored = await client.storage.put(
        "note",
        snapshot,
        stored?.revision ?? null,
      );
      if (note.value === snapshot) dirty = false;
      status.textContent = "Remembered locally for this app.";
    }),
  ];
  function refresh() {
    updates.forEach((update) => update());
  }
  if (supported("system.storage.get")) {
    try {
      stored = await client.storage.get("note");
      if (!dirty && typeof stored?.value === "string")
        note.value = stored.value;
    } catch (error) {
      failed(error);
    }
  }
  refresh();
  status.textContent =
    "Ready. File actions become available when the workspace supports them.";
  client.events.subscribe(() => {
    void client.services
      .list()
      .then((methods) => {
        capabilities.clear();
        methods.forEach((method) => capabilities.set(method.name, method));
        refresh();
      })
      .catch(failed);
  }, failed);
}
void start().catch((error) => {
  status.textContent = String(error);
});
