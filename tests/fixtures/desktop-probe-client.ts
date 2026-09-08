// SPDX-License-Identifier: MPL-2.0
// The real SDK example, with test-only controls for the opaque frame's DOM.
import "../../examples/dialog-app/main";
window.addEventListener("message", (event) => {
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
  parent.postMessage(
    {
      type: "desktop-probe-result",
      request: event.data.request,
      text: note.value,
      status: document.querySelector("output")!.textContent,
      ready: !document.querySelector<HTMLButtonElement>("#message")!.disabled,
    },
    "*",
  );
});
