// SPDX-License-Identifier: MPL-2.0
// Open with Vite at /tests/fixtures/connect-dismiss-probe.html.
// Real connection form, synthetic input events; no host, storage or clipboard access.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConnectDialog } from "../../src/components/ConnectDialog";
import "../../src/styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.querySelector<HTMLDivElement>("#root")!;
const result = document.querySelector<HTMLPreElement>("#result")!;
const root = createRoot(container);
let closed = 0;
let canceled = 0;
const profile = {
  id: "fixture",
  name: "Fixture",
  host: "  192.0.2.1",
  port: 22,
  username: "user",
  keyPath: "",
};
const render = (busy = false) =>
  root.render(
    <ConnectDialog
      profiles={[profile]}
      busy={busy}
      error=""
      preview={false}
      close={() => {
        closed++;
      }}
      cancelConnect={() => {
        canceled++;
      }}
      submit={() => {
        throw new Error("Unexpected connection");
      }}
      save={async () => {
        throw new Error("Unexpected save");
      }}
      remove={async () => {
        throw new Error("Unexpected removal");
      }}
    />,
  );
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const pointer = (
  target: Element,
  type: string,
  button = 0,
  pointerType = "mouse",
) =>
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button,
      pointerId: 1,
      isPrimary: true,
      pointerType,
    }),
  );
const click = (target: Element) =>
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const passed: string[] = [];
try {
  await act(async () => render());
  const backdrop = container.querySelector(".modal-backdrop")!;
  const host = container.querySelector<HTMLInputElement>(
    'input[placeholder="server.example.com"]',
  )!;
  await act(async () => {
    pointer(host, "pointerdown");
    host.setSelectionRange(0, 2);
    pointer(backdrop, "pointerup");
    // Browsers retarget a cross-element click to the common ancestor.
    click(backdrop);
  });
  check(
    closed === 0,
    "Selecting text then releasing over the backdrop closed the dialog",
  );
  check(
    host.value === profile.host &&
      host.selectionStart === 0 &&
      host.selectionEnd === 2,
    "Host text or selection was lost",
  );
  passed.push(
    "Selecting leading whitespace and releasing outside preserves the dialog and draft",
  );
  await act(async () => {
    pointer(host, "pointerdown");
    pointer(host, "pointerup");
    click(host);
  });
  check(closed === 0, "Clicking inside the form dismissed it");
  passed.push("Inside clicks stay inside the form");
  await act(async () => pointer(backdrop, "pointerdown", 2));
  check(closed === 0, "Secondary backdrop press dismissed the form");
  passed.push("Right-click does not dismiss");
  await act(async () => pointer(backdrop, "pointerdown"));
  check(Number(closed) === 1, "A direct backdrop press did not dismiss");
  passed.push("Direct primary backdrop press still dismisses");
  await act(async () => render(true));
  await act(async () => pointer(backdrop, "pointerdown"));
  check(Number(closed) === 1, "Backdrop dismissed a busy connection");
  passed.push("Busy connection remains protected");
  await act(async () => render());
  await act(async () => pointer(backdrop, "pointerdown", 0, "touch"));
  check(Number(closed) === 2, "Direct touch backdrop press did not dismiss");
  passed.push("Direct touch backdrop press still dismisses");
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  check(Number(closed) === 3, "Escape stopped working");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Close connection dialog"]',
      )!
      .click(),
  );
  check(Number(closed) === 4 && canceled === 0, "Close button stopped working");
  passed.push("Escape and the close button still work");
  result.textContent = `PASS: ${passed.length} checks\n${passed.join("\n")}`;
} catch (error) {
  result.textContent = `FAIL: ${String(error)}\n${passed.join("\n")}`;
  throw error;
} finally {
  await act(async () => root.unmount());
}
