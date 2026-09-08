// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { AppConsoles, type AppConsoleSource } from "./console-bridge";
import { RpcPeer, type RpcTransport } from "./rpc";
import { appConsoleClient } from "../../packages/app-sdk/src/console-client";
import type { TerminalEvent, TerminalSession } from "../sdk";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(grants = ["system.console"]) {
  const handles: {
    handle: TerminalSession;
    emit(event: TerminalEvent): void | Promise<void>;
  }[] = [];
  const services = {
    terminal: vi.fn(
      async (
        _cols: number,
        _rows: number,
        emit: (event: TerminalEvent) => void | Promise<void>,
      ) => {
        const handle: TerminalSession = {
          resizable: true,
          write: vi.fn(async () => {}),
          resize: vi.fn(async () => {}),
          close: vi.fn(async () => {}),
        };
        handles.push({ handle, emit });
        return handle;
      },
    ),
  };
  let source: AppConsoleSource | undefined = { binding: "first", services };
  const report = vi.fn();
  const owner = new AppConsoles(() => source, report);
  const inputs: ((raw: unknown) => void)[] = [() => {}, () => {}];
  const transports = [0, 1].map((index): RpcTransport => ({
    send: (raw) => queueMicrotask(() => inputs[1 - index](raw)),
    subscribe(receive) {
      inputs[index] = receive;
      return () => {
        inputs[index] = () => {};
      };
    },
    close() {},
  }));
  const server = new RpcPeer(transports[1], owner.methods(), grants);
  const peer = new RpcPeer(transports[0]);
  server.onClose(() => owner.close());
  return {
    owner,
    services,
    handles,
    peer,
    api: appConsoleClient(peer),
    report,
    replace() {
      source = { binding: "second", services: { ...services } };
      owner.refresh();
    },
    close() {
      peer.close();
      server.close();
      owner.close();
    },
  };
}
it("preserves binary chunks, backpressures reads, chunks writes and keeps consoles independent", async () => {
  const t = setup();
  try {
    const first = await t.api.open({ binding: "first" });
    const second = await t.api.open({ binding: "first", cols: 120, rows: 40 });
    let consumed = false;
    const output = Promise.resolve(
      t.handles[0].emit({ type: "output", data: [0, 255, 240, 159] }),
    ).then(() => {
      consumed = true;
    });
    await Promise.resolve();
    expect(consumed).toBe(false);
    await second.write("alive 🌿");
    expect(t.handles[1].handle.write).toHaveBeenCalledWith(
      new TextEncoder().encode("alive 🌿"),
    );
    expect(await first.read()).toEqual(Uint8Array.from([0, 255, 240, 159]));
    await output;
    expect(consumed).toBe(true);
    const bytes = Uint8Array.from({ length: 150000 }, (_, i) => i % 256);
    await first.write(bytes);
    const writes = vi
      .mocked(t.handles[0].handle.write)
      .mock.calls.map(([part]) => part as Uint8Array);
    expect(writes.map((part) => part.length)).toEqual([65536, 65536, 18928]);
    expect(Uint8Array.from(writes.flatMap((part) => [...part]))).toEqual(bytes);
    await first.resize(100, 30);
    expect(t.handles[0].handle.resize).toHaveBeenCalledWith(100, 30);
    await first.close();
    await expect(first.write("retired")).rejects.toMatchObject({
      code: "closed",
    });
    await second.write("still alive");
    await second.close();
    expect(t.handles[0].handle.close).toHaveBeenCalledOnce();
    expect(t.handles[1].handle.close).toHaveBeenCalledOnce();
  } finally {
    t.close();
  }
});
it("keeps EOF distinct from errors, forbids overlapping reads and closes a canceled reader", async () => {
  const t = setup();
  try {
    const console = await t.api.open({ binding: "first" });
    const abort = new AbortController();
    const pending = console.read(abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await expect(console.read()).rejects.toMatchObject({ code: "busy" });
    abort.abort();
    await rejected;
    await vi.waitFor(() =>
      expect(t.handles[0].handle.close).toHaveBeenCalledOnce(),
    );
    await expect(console.read()).rejects.toMatchObject({ code: "closed" });
    const eof = await t.api.open({ binding: "first" });
    await t.handles[1].emit({ type: "closed" });
    expect(await eof.read()).toBeNull();
    await eof.close();
    const error = await t.api.open({ binding: "first" });
    await t.handles[2].emit({ type: "error", data: "Device stopped" });
    await expect(error.read()).rejects.toMatchObject({
      code: "failed",
      message: "Device stopped",
    });
    await error.close();
  } finally {
    t.close();
  }
});
it("enforces grants, window ownership, source changes and cleanup on channel closure", async () => {
  const denied = setup([]),
    a = setup(),
    b = setup();
  try {
    await expect(denied.api.open({ binding: "first" })).rejects.toMatchObject({
      code: "denied",
    });
    expect(denied.services.terminal).not.toHaveBeenCalled();
    await a.peer.call("system.console.open", {
      id: "owned",
      binding: "first",
      cols: 80,
      rows: 24,
    });
    await expect(
      b.peer.call("system.console.read", { id: "owned" }),
    ).rejects.toMatchObject({ code: "closed" });
    await b.peer.call("system.console.close", { id: "owned" });
    expect(a.handles[0].handle.close).not.toHaveBeenCalled();
    const waiting = a.peer.call("system.console.read", { id: "owned" });
    const rejected = expect(waiting).rejects.toMatchObject({ code: "closed" });
    a.replace();
    await rejected;
    await vi.waitFor(() =>
      expect(a.handles[0].handle.close).toHaveBeenCalledOnce(),
    );
    await expect(a.api.open({ binding: "first" })).rejects.toMatchObject({
      code: "closed",
    });
    const next = await a.api.open({ binding: "second" });
    a.peer.close();
    await vi.waitFor(() =>
      expect(a.handles[1].handle.close).toHaveBeenCalledOnce(),
    );
    await expect(next.write("closed")).rejects.toMatchObject({
      code: "closed",
    });
  } finally {
    denied.close();
    a.close();
    b.close();
  }
});
it("keeps canceled pending opens charged and closes every late handle exactly once", async () => {
  const t = setup();
  const opens: ReturnType<typeof deferred<TerminalSession>>[] = [];
  t.services.terminal.mockImplementation(() => {
    const open = deferred<TerminalSession>();
    opens.push(open);
    return open.promise;
  });
  try {
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      t.api
        .open({ binding: "first" }, controller.signal)
        .catch((error) => error),
    );
    await vi.waitFor(() => expect(opens).toHaveLength(16));
    controllers.forEach((controller) => controller.abort());
    await Promise.all(pending);
    await expect(t.api.open({ binding: "first" })).rejects.toMatchObject({
      code: "busy",
    });
    const close = vi.fn(async () => {});
    opens.forEach((open) =>
      open.resolve({ close, write: async () => {}, resize: async () => {} }),
    );
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(16));
    t.services.terminal.mockResolvedValue({
      close,
      write: async () => {},
      resize: async () => {},
    });
    const next = await t.api.open({ binding: "first" });
    await next.close();
    expect(close).toHaveBeenCalledTimes(17);
  } finally {
    t.close();
  }
});
it("keeps canceled native writes charged until they actually settle", async () => {
  const t = setup();
  const writes: ReturnType<typeof deferred<void>>[] = [];
  const close = vi.fn(async () => {});
  t.services.terminal.mockImplementation(async () => ({
    close,
    resize: async () => {},
    write: async () => {
      const pending = deferred<void>();
      writes.push(pending);
      await pending.promise;
    },
  }));
  try {
    const consoles = await Promise.all(
      Array.from({ length: 16 }, () => t.api.open({ binding: "first" })),
    );
    const controllers = consoles.map(() => new AbortController());
    const pending = consoles.map((console, i) =>
      console.write("input", controllers[i].signal).catch((error) => error),
    );
    await vi.waitFor(() => expect(writes).toHaveLength(16));
    controllers.forEach((controller) => controller.abort());
    await Promise.all(pending);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(16));
    await expect(t.api.open({ binding: "first" })).rejects.toMatchObject({
      code: "busy",
    });
    writes.forEach((pending) => pending.resolve());
    await vi.waitFor(async () => {
      const next = await t.api.open({ binding: "first" });
      await next.close();
    });
  } finally {
    writes.forEach((pending) => pending.resolve());
    t.close();
  }
});
it("retains capacity after uncertain cleanup rather than opening unbounded replacement resources", async () => {
  const t = setup();
  t.services.terminal.mockResolvedValue({
    write: async () => {},
    resize: async () => {},
    close: async () => {
      throw new Error("Cleanup unconfirmed");
    },
  });
  try {
    for (let i = 0; i < 16; i++) {
      const console = await t.api.open({ binding: "first" });
      await expect(console.close()).rejects.toMatchObject({ code: "failed" });
    }
    await expect(t.api.open({ binding: "first" })).rejects.toMatchObject({
      code: "busy",
    });
  } finally {
    t.close();
  }
});
it("reports a provider ignoring flow control and closes it once without hiding buffered bytes", async () => {
  const t = setup();
  try {
    const console = await t.api.open({ binding: "first" });
    const pending = t.handles[0].emit({ type: "output", data: [1, 255] });
    await t.handles[0].emit({ type: "output", data: [2] });
    expect(await console.read()).toEqual(new Uint8Array([1, 255]));
    await pending;
    await expect(console.read()).rejects.toMatchObject({ code: "failed" });
    await console.close();
    expect(t.handles[0].handle.close).toHaveBeenCalledOnce();
  } finally {
    t.close();
  }
});
it("exposes fixed-size consoles and refuses malformed bytes and uncertain repeated writes", async () => {
  const t = setup();
  const write = vi.fn(async () => {
    throw new Error("Input interrupted");
  });
  const close = vi.fn(async () => {});
  t.services.terminal.mockResolvedValue({
    resizable: false,
    write,
    close,
    resize: vi.fn(),
  });
  try {
    await expect(
      t.api.open({ binding: "first", cols: 0 }),
    ).rejects.toMatchObject({ code: "invalid" });
    await t.peer.call("system.console.open", {
      id: "raw",
      binding: "first",
      cols: 80,
      rows: 24,
    });
    await expect(
      t.peer.call("system.console.write", { id: "raw", bytes: [256] }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(write).not.toHaveBeenCalled();
    const console = await t.api.open({ binding: "first" });
    expect(console.resizable).toBe(false);
    await expect(console.resize(100, 30)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(console.write(new Uint8Array([1]))).rejects.toMatchObject({
      code: "failed",
    });
    await expect(console.write(new Uint8Array([2]))).rejects.toMatchObject({
      code: "closed",
    });
    expect(write).toHaveBeenCalledOnce();
  } finally {
    t.close();
  }
});
