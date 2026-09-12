// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { saveTextWithConfirmation } from "./text-save";
import type { SessionServices, TextDocument } from "./sdk";

const document: TextDocument = {
  path: "opaque:file",
  name: "note",
  parent: null,
  text: "old",
  revision: "rev",
  writable: true,
  saveRequiresConfirmation: true,
};
it("sends no write when confirmation is declined or its draft becomes stale", async () => {
  const saveText = vi.fn();
  const services = { saveText } as unknown as SessionServices;
  await saveTextWithConfirmation(
    services,
    document,
    "new",
    async () => false,
    () => true,
  );
  await saveTextWithConfirmation(
    services,
    document,
    "new",
    async () => true,
    () => false,
  );
  expect(saveText).not.toHaveBeenCalled();
});
it("requires a fresh confirmation for each non-atomic save and leaves ordinary saves unchanged", async () => {
  const saveText = vi.fn(async () => document);
  const services = { saveText } as unknown as SessionServices;
  const confirm = vi.fn(async () => true);
  await saveTextWithConfirmation(
    services,
    document,
    "new",
    confirm,
    () => true,
  );
  expect(saveText).toHaveBeenLastCalledWith(document.path, "new", "rev", true);
  await saveTextWithConfirmation(
    services,
    document,
    "again",
    confirm,
    () => true,
  );
  expect(confirm).toHaveBeenCalledTimes(2);
  await saveTextWithConfirmation(
    services,
    { ...document, saveRequiresConfirmation: false },
    "atomic",
    confirm,
    () => true,
  );
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(saveText).toHaveBeenLastCalledWith(document.path, "atomic", "rev");
});
