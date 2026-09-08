// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { prepareSaveAs, commitSaveAs } from "./save-as";
import type { SessionServices, Directory, TextDocument } from "./sdk";

function fixture() {
  const target: TextDocument = {
    path: "object@canonical",
    name: "notes.txt",
    parent: "node@root",
    text: "Original",
    revision: "r1",
    writable: true,
  };
  const directory: Directory = {
    path: "node@root",
    name: "Root",
    parent: null,
    home: null,
    roots: [],
    entries: [
      {
        path: "object@opaque",
        name: "notes.txt",
        kind: "file",
        size: 8,
        modified: null,
      },
    ],
  };
  const list = vi.fn(async () => directory);
  const readText = vi.fn(async () => ({ ...target }));
  const createText = vi.fn(async () => ({ ...target }));
  const saveText = vi.fn(
    async (_path: string, text: string, revision: string) => {
      if (revision !== target.revision) throw new Error("CONFLICT");
      target.text = text;
      target.revision = "r2";
      return { ...target };
    },
  );
  const services = {
    list,
    readText,
    createText,
    saveText,
  } as unknown as SessionServices;
  return { target, directory, services, list, readText, createText, saveText };
}
it("prepares an opaque destination without writing and commits only its reviewed revision", async () => {
  const f = fixture();
  const review = await prepareSaveAs(
    f.services,
    "root-alias",
    "notes.txt",
    true,
  );
  expect(f.readText).toHaveBeenCalledWith("object@opaque");
  expect(f.saveText).not.toHaveBeenCalled();
  expect(f.createText).not.toHaveBeenCalled();
  expect(Object.isFrozen(review)).toBe(true);
  await commitSaveAs(f.services, review, "New 🌍\r\n");
  expect(f.saveText).toHaveBeenCalledWith(
    "object@canonical",
    "New 🌍\r\n",
    "r1",
  );
});
it("retains the reviewed revision across conflict and requires a fresh explicit review", async () => {
  const f = fixture();
  const review = await prepareSaveAs(f.services, "root", "notes.txt", true);
  f.target.revision = "external";
  f.target.text = "External change";
  await expect(commitSaveAs(f.services, review, "draft")).rejects.toThrow(
    "CONFLICT",
  );
  expect(f.target.text).toBe("External change");
  await expect(commitSaveAs(f.services, review, "draft")).rejects.toThrow(
    "CONFLICT",
  );
  expect(f.readText).toHaveBeenCalledTimes(1);
  const refreshed = await prepareSaveAs(f.services, "root", "notes.txt", true);
  await commitSaveAs(f.services, refreshed, "draft");
  expect(f.target.text).toBe("draft");
});
it("creates through a canonical parent and never falls back to overwrite after a collision", async () => {
  const f = fixture();
  const destination = await prepareSaveAs(
    f.services,
    "root-alias",
    "new.txt",
    false,
  );
  f.createText.mockRejectedValueOnce(new Error("Already exists"));
  await expect(commitSaveAs(f.services, destination, "Draft")).rejects.toThrow(
    "Already exists",
  );
  expect(f.createText).toHaveBeenCalledWith("node@root", "new.txt", "Draft");
  expect(f.readText).not.toHaveBeenCalled();
  expect(f.saveText).not.toHaveBeenCalled();
});
it("refuses folders, symlinks, ambiguous names and unsupported replacement before any write", async () => {
  const f = fixture();
  for (const kind of ["directory", "symlink"] as const) {
    f.directory.entries[0].kind = kind;
    await expect(
      prepareSaveAs(f.services, "root", "notes.txt", true),
    ).rejects.toThrow("folder or link");
  }
  f.directory.entries[0].kind = "file";
  await expect(
    prepareSaveAs(f.services, "root", "notes.txt", false),
  ).rejects.toThrow("unavailable");
  f.directory.entries.push({ ...f.directory.entries[0] });
  await expect(
    prepareSaveAs(f.services, "root", "notes.txt", true),
  ).rejects.toThrow("ambiguous");
  expect(f.readText).not.toHaveBeenCalled();
  expect(f.saveText).not.toHaveBeenCalled();
});
it("propagates unreadable and readonly destination errors without attempting mutation", async () => {
  const f = fixture();
  f.readText.mockRejectedValueOnce(new Error("Not UTF-8"));
  await expect(
    prepareSaveAs(f.services, "root", "notes.txt", true),
  ).rejects.toThrow("Not UTF-8");
  f.target.writable = false;
  await expect(
    prepareSaveAs(f.services, "root", "notes.txt", true),
  ).rejects.toThrow("cannot be replaced");
  expect(f.createText).not.toHaveBeenCalled();
  expect(f.saveText).not.toHaveBeenCalled();
});
