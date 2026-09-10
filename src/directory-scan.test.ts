// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { directoryLocation, scanDirectory } from "./directory-scan";
import type { Directory, DirectoryPage, DirectoryReader } from "./sdk";

const directory = (start: number, count: number): Directory => ({
  path: "opaque:root",
  name: "Root",
  parent: null,
  home: null,
  roots: [],
  entries: Array.from({ length: count }, (_, offset) => ({
    path: `opaque:${start + offset}`,
    name: `Item ${start + offset}`,
    kind: "file",
    size: 1,
    modified: null,
  })),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("resolves a default save location from one page without consuming its inventory", async () => {
  const next = vi.fn(async () => ({
    directory: directory(0, 128),
    done: false,
  }));
  const close = vi.fn(async () => {});
  const location = await directoryLocation({
    list: vi.fn(),
    openDirectory: async () => ({ next, close }),
  });
  expect(location.path).toBe("opaque:root");
  expect(location).not.toHaveProperty("entries");
  expect(next).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("publishes the first page before a slow next page and closes before final delivery", async () => {
  const pending = deferred<DirectoryPage>();
  const next = vi
    .fn()
    .mockResolvedValueOnce({ directory: directory(0, 128), done: false })
    .mockReturnValueOnce(pending.promise);
  const close = vi.fn(async () => {});
  const list = vi.fn();
  const pages: Directory[] = [];
  const scan = scanDirectory(
    { list, openDirectory: async () => ({ next, close }) },
    undefined,
    new AbortController().signal,
    (page, done) => {
      if (done) expect(close).toHaveBeenCalledOnce();
      pages.push(page);
    },
  );
  await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(2));
  expect(pages).toHaveLength(1);
  expect(pages[0].entries).toHaveLength(128);
  pending.resolve({ directory: directory(128, 5), done: true });
  await scan;
  expect(pages.at(-1)!.entries).toHaveLength(133);
  expect(pages[0].entries).toHaveLength(128);
  expect(list).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("closes a canceled scan and never publishes a late page from the old location", async () => {
  const pending = deferred<DirectoryPage>();
  const next = vi
    .fn()
    .mockResolvedValueOnce({ directory: directory(0, 1), done: false })
    .mockReturnValueOnce(pending.promise);
  const close = vi.fn(async () => {});
  const controller = new AbortController();
  const publish = vi.fn();
  const scan = scanDirectory(
    { list: vi.fn(), openDirectory: async () => ({ next, close }) },
    "old",
    controller.signal,
    publish,
  );
  const rejected = expect(scan).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(2));
  controller.abort();
  expect(close).toHaveBeenCalledOnce();
  pending.resolve({ directory: directory(1, 1), done: true });
  await rejected;
  expect(publish).toHaveBeenCalledTimes(1);
});

it("releases a late open without reading and reports cleanup failure without publishing completion", async () => {
  const pending = deferred<DirectoryReader>();
  const reader = { next: vi.fn(), close: vi.fn(async () => {}) };
  const controller = new AbortController();
  const publish = vi.fn();
  const scan = scanDirectory(
    { list: vi.fn(), openDirectory: () => pending.promise },
    undefined,
    controller.signal,
    publish,
  );
  const rejected = expect(scan).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  pending.resolve(reader);
  await rejected;
  expect(reader.next).not.toHaveBeenCalled();
  expect(reader.close).toHaveBeenCalledOnce();
  const close = vi.fn(async () => {
    throw new Error("close failed");
  });
  await expect(
    scanDirectory(
      {
        list: vi.fn(),
        openDirectory: async () => ({
          next: async () => ({ directory: directory(0, 1), done: true }),
          close,
        }),
      },
      undefined,
      new AbortController().signal,
      publish,
    ),
  ).rejects.toThrow("close failed");
  expect(publish).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("keeps scans unbounded, coalesces duplicate identities, and yields to cancellation", async () => {
  let offset = 0;
  const close = vi.fn(async () => {});
  const publish = vi.fn();
  await scanDirectory(
    {
      list: vi.fn(),
      openDirectory: async () => ({
        close,
        next: async () => {
          const start = offset;
          offset += 128;
          return {
            directory: directory(
              start === 128 ? 0 : start,
              Math.min(128, 50_000 - start),
            ),
            done: offset >= 50_000,
          };
        },
      }),
    },
    undefined,
    new AbortController().signal,
    publish,
  );
  expect(publish.mock.calls.at(-1)![0].entries).toHaveLength(50_000 - 128);
  expect(publish.mock.calls.at(-1)![1]).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it("rejects changing navigation and empty continuation pages while preserving earlier snapshots", async () => {
  for (const invalid of [
    { directory: { ...directory(1, 1), path: "other" }, done: false },
    { directory: directory(0, 0), done: false },
  ]) {
    const close = vi.fn(async () => {});
    const next = vi
      .fn()
      .mockResolvedValueOnce({ directory: directory(0, 1), done: false })
      .mockResolvedValueOnce(invalid);
    const publish = vi.fn();
    await expect(
      scanDirectory(
        { list: vi.fn(), openDirectory: async () => ({ next, close }) },
        undefined,
        new AbortController().signal,
        publish,
      ),
    ).rejects.toThrow("Directory changed");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
  }
});
