// SPDX-License-Identifier: MPL-2.0
// Copied into the independent generated project by verify-sdk; no desktop imports.
// @ts-ignore The generated project's app.ts is supplied by its starter.
import "./app";
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.type !== "sdk-starter-probe")
    return;
  const note = document.querySelector<HTMLTextAreaElement>("textarea");
  if (event.data.action === "edit" && note) {
    note.value = "A note built outside the desktop repository.";
    note.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (["message", "browse", "save", "remember"].includes(event.data.action))
    document.querySelector<HTMLButtonElement>(`#${event.data.action}`)?.click();
  parent.postMessage(
    {
      type: "sdk-starter-result",
      id: event.data.id,
      title: document.querySelector("h1")?.textContent,
      status: document.querySelector("output")?.textContent,
      note: note?.value,
      ready: !document.querySelector<HTMLButtonElement>("#message")?.disabled,
    },
    "*",
  );
});
