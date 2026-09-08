// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from "vitest";
import { DialogQueue, SystemScope } from "./system-dialogs";
import type { SessionServices } from "./sdk";

function fixture(queue = new DialogQueue()) {
  const state = { revision: "text-r1" };
  const services = {
    list: vi.fn(async () => ({
      path: "opaque:root",
      name: "Device",
      parent: null,
      home: null,
      roots: [],
      entries: [
        {
          name: "draft.txt",
          path: "opaque:file",
          kind: "file",
          revision: "entry-r1",
          size: 3,
          modified: null,
        },
      ],
    })),
    readText: vi.fn(async () => ({
      path: "opaque:file",
      name: "draft.txt",
      parent: "opaque:root",
      text: "old",
      revision: state.revision,
      writable: true,
    })),
    saveText: vi.fn(async (_path, text, revision) => {
      if (state.revision !== revision) throw new Error("Source changed");
      return {
        path: "opaque:file",
        name: "draft.txt",
        parent: "opaque:root",
        text,
        revision: "text-r2",
        writable: true,
      };
    }),
    createText: vi.fn(async (_parent, name, text) => ({
      path: "opaque:new",
      name,
      text,
      parent: "opaque:root",
      revision: "text-new",
      writable: true,
    })),
  } as unknown as SessionServices;
  const scope = new SystemScope(
    "Sample app",
    services,
    () => true,
    vi.fn(),
    queue,
  );
  return { queue, scope, services, state };
}
describe("window-owned system dialogs", () => {
  it("a no-replacement Save As cannot read or overwrite an existing file even with broad window capabilities", async () => {
    const { queue, scope, services } = fixture();
    const saving = scope.api.files.saveTextAs({
      text: "draft",
      allowReplace: false,
    });
    const rejected = expect(saving).rejects.toThrow(
      "Replacing files is unavailable",
    );
    queue.snapshot()[0].resolve({ parent: "opaque:root", name: "draft.txt" });
    await rejected;
    expect(services.readText).not.toHaveBeenCalled();
    expect(services.saveText).not.toHaveBeenCalled();
    expect(queue.snapshot()).toHaveLength(0);
  });
  it("queues independent windows, snapshots options, and revokes only the closed owner's requests", async () => {
    const { queue, scope } = fixture();
    const sibling = fixture(queue).scope;
    const options = {
      title: "Review",
      message: "Original",
      buttons: [{ id: "keep", label: "Keep" }],
    };
    const first = scope.api.dialogs.messageBox(options);
    const rejected = expect(first).rejects.toMatchObject({ code: "closed" });
    options.message = "Mutated";
    options.buttons[0].label = "Mutated";
    const other = sibling.api.dialogs.messageBox({
      title: "Other",
      message: "Independent",
    });
    const captured = queue.snapshot()[0];
    expect(captured.options).toMatchObject({
      message: "Original",
      buttons: [{ label: "Keep" }],
    });
    scope.dispose();
    await rejected;
    captured.resolve("keep");
    expect(queue.snapshot()).toHaveLength(1);
    queue.snapshot()[0].resolve("ok");
    expect(await other).toBe("ok");
    await expect(scope.api.dialogs.messageBox(options)).rejects.toMatchObject({
      code: "closed",
    });
  });
  it("honors abort before and during a request, and refuses hidden-window prompts", async () => {
    const { queue, scope } = fixture();
    const signal = new AbortController();
    signal.abort();
    await expect(
      scope.api.dialogs.openFile({}, { signal: signal.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(queue.snapshot()).toHaveLength(0);
    const pending = new AbortController();
    const request = scope.api.dialogs.saveFile({}, { signal: pending.signal });
    const rejected = expect(request).rejects.toMatchObject({ code: "aborted" });
    pending.abort();
    await rejected;
    scope.setVisible(false);
    await expect(
      scope.api.dialogs.messageBox({
        title: "Hidden",
        message: "Do not steal focus",
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    scope.setVisible(true);
    const next = scope.api.dialogs.openFile();
    queue.snapshot()[0].resolve(null);
    expect(await next).toBeNull();
  });
  it("rejects undeclared or lost file access and invalid message buttons before rendering", async () => {
    const { queue, services } = fixture();
    let allowed = false;
    const scope = new SystemScope(
      "Reader",
      services,
      () => allowed,
      () => {},
      queue,
    );
    await expect(scope.api.dialogs.openFile()).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      scope.api.dialogs.messageBox({
        title: "Invalid",
        message: "Bad",
        defaultId: "missing",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(queue.snapshot()).toHaveLength(0);
    allowed = true;
    const request = scope.api.dialogs.openFile();
    allowed = false;
    queue.snapshot()[0].resolve([]);
    await expect(request).rejects.toMatchObject({ code: "unavailable" });
  });
  it("picking a save destination alone never writes or reads file contents", async () => {
    const { scope, queue, services } = fixture();
    const result = scope.api.dialogs.saveFile({
      directory: "opaque:root",
      name: "draft.txt",
    });
    queue.snapshot()[0].resolve({ parent: "opaque:root", name: "draft.txt" });
    expect(await result).toEqual({ parent: "opaque:root", name: "draft.txt" });
    expect(services.readText).not.toHaveBeenCalled();
    expect(services.saveText).not.toHaveBeenCalled();
    expect(services.createText).not.toHaveBeenCalled();
  });
  it("text Save As requires explicit replacement and retains the reviewed revision", async () => {
    const { scope, queue, services, state } = fixture();
    const saving = scope.api.files.saveTextAs({
      text: "new",
      name: "draft.txt",
    });
    queue.snapshot()[0].resolve({ parent: "opaque:root", name: "draft.txt" });
    await vi.waitFor(() => expect(queue.snapshot()[0]?.kind).toBe("message"));
    expect(services.saveText).not.toHaveBeenCalled();
    state.revision = "changed-after-review";
    queue.snapshot()[0].resolve("replace");
    await expect(saving).rejects.toThrow("Source changed");
    expect(services.saveText).toHaveBeenCalledWith(
      "opaque:file",
      "new",
      "text-r1",
    );
  });
  it("Cancel preserves sources; create snapshots text and never constructs provider paths", async () => {
    const { scope, queue, services } = fixture();
    const canceled = scope.api.files.saveTextAs({ text: "draft" });
    queue.snapshot()[0].resolve({ parent: "opaque:root", name: "draft.txt" });
    await vi.waitFor(() => expect(queue.snapshot()[0]?.kind).toBe("message"));
    queue.snapshot()[0].resolve("cancel");
    expect(await canceled).toBeNull();
    expect(services.saveText).not.toHaveBeenCalled();
    const options = { text: "original draft", name: "new.txt" };
    const created = scope.api.files.saveTextAs(options);
    options.text = "late mutation";
    queue.snapshot()[0].resolve({ parent: "opaque:root", name: "new.txt" });
    expect((await created)?.text).toBe("original draft");
    expect(services.createText).toHaveBeenCalledWith(
      "opaque:root",
      "new.txt",
      "original draft",
    );
  });
  it("closing during destination inspection cannot prompt or write later", async () => {
    const { scope, queue, services } = fixture();
    let release!: (value: Awaited<ReturnType<SessionServices["list"]>>) => void;
    vi.mocked(services.list).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const saving = scope.api.files.saveTextAs({ text: "draft" });
    queue.snapshot()[0].resolve({ parent: "opaque:root", name: "new.txt" });
    await vi.waitFor(() => expect(release).toBeDefined());
    scope.dispose();
    release({
      path: "opaque:root",
      name: "Root",
      parent: null,
      home: null,
      roots: [],
      entries: [],
    });
    await expect(saving).rejects.toMatchObject({ code: "closed" });
    expect(queue.snapshot()).toHaveLength(0);
    expect(services.createText).not.toHaveBeenCalled();
  });
});
