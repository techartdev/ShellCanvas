// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { bindSession } from "./session-services";
import { scopeAppServices } from "./app-services";
import { apps } from "./apps/registry";
import { previewServices, previewSession } from "./preview";
import { watchFileChanges } from "./file-events";
import type { Session, TransferTicket } from "./sdk";

const session: Session = {
  ...previewSession,
  id: 90,
  info: { ...previewSession.info, capabilities: ["files.read", "files.copy"] },
};
const ticket: TransferTicket = {
  id: 8,
  name: "binary.bin",
  size: 3,
  direction: "copy",
};
it("routes opaque copy tickets through declared app scope and refreshes files on completion", async () => {
  const prepareCopy = vi.fn(async () => ticket);
  const runTransfer = vi.fn(async () => ({
    status: "completed" as const,
    bytes: 3,
    total: 3,
    path: "copy@2",
  }));
  const binding = bindSession(
    { ...previewServices, prepareCopy, runTransfer },
    session,
  );
  const files = scopeAppServices(
    binding.services,
    apps.find((app) => app.id === "files")!,
  );
  const editor = scopeAppServices(
    binding.services,
    apps.find((app) => app.id === "editor")!,
  );
  await expect(
    editor.prepareCopy("object@1", "rev", "folder@2"),
  ).rejects.toThrow("did not declare");
  expect(prepareCopy).not.toHaveBeenCalled();
  const changed = vi.fn();
  const stop = watchFileChanges(90, changed);
  const prepared = await files.prepareCopy("object@1", "rev", "folder@2");
  expect(prepareCopy).toHaveBeenCalledWith(90, "object@1", "rev", "folder@2");
  // Callers cannot change the operation or gain another direction's capability.
  await expect(
    files.runTransfer({ ...prepared, direction: "upload" }, () => {}),
  ).resolves.toMatchObject({ status: "completed" });
  expect(runTransfer).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  await expect(editor.runTransfer(prepared, () => {})).rejects.toThrow(
    "does not belong",
  );
  stop();
  binding.dispose();
});
it("cleans up copy tickets prepared after disconnect and refuses unsupported sessions", async () => {
  let finish!: (ticket: TransferTicket) => void;
  const prepareCopy = vi.fn(
    () =>
      new Promise<TransferTicket>((resolve) => {
        finish = resolve;
      }),
  );
  const cancelTransfer = vi.fn(async () => {});
  const backend = { ...previewServices, prepareCopy, cancelTransfer };
  const unavailable = bindSession(backend, previewSession);
  await expect(
    unavailable.services.prepareCopy("object@1", "rev", "folder@2"),
  ).rejects.toThrow("files.copy");
  expect(prepareCopy).not.toHaveBeenCalled();
  const binding = bindSession(backend, session);
  const pending = binding.services.prepareCopy("object@1", "rev", "folder@2");
  binding.dispose();
  finish(ticket);
  await expect(pending).rejects.toThrow("no longer connected");
  expect(cancelTransfer).toHaveBeenCalledWith(90, ticket.id);
  unavailable.dispose();
});
