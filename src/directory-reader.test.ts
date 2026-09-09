// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { nativeDirectory } from "./directory-reader";
import type { DirectoryPage } from "./sdk";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const page: DirectoryPage = {
  done: false,
  directory: {
    path: "opaque:root",
    name: "Root",
    parent: null,
    home: null,
    roots: [],
    entries: [],
  },
};
it("requests native pages on demand and keeps cleanup available after EOF", async () => {
  const invoke = vi.fn(async (command: string) =>
    command === "open_directory"
      ? "reader"
      : command === "read_directory"
        ? { ...page, done: true }
        : undefined,
  );
  const reader = await nativeDirectory(invoke as never, 42, "opaque:root");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "open_directory",
  ]);
  expect((await reader.next()).done).toBe(true);
  await expect(reader.next()).rejects.toThrow("closed");
  await reader.close();
  await reader.close();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "open_directory",
    "read_directory",
    "close_directory",
  ]);
});
it("closes a late reservation after cancellation without reading a page", async () => {
  const opening = deferred<string>();
  const signal = new AbortController();
  const invoke = vi.fn(async (command: string) =>
    command === "open_directory" ? opening.promise : undefined,
  );
  const pending = nativeDirectory(
    invoke as never,
    42,
    undefined,
    signal.signal,
  );
  signal.abort();
  opening.resolve("late");
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "open_directory",
    "close_directory",
  ]);
});
it("cancels a pending page promptly while native cleanup continues and keeps its failure", async () => {
  const reading = deferred<DirectoryPage>();
  const cleanup = deferred<void>();
  const invoke = vi.fn(async (command: string) =>
    command === "open_directory"
      ? "reader"
      : command === "read_directory"
        ? reading.promise
        : cleanup.promise,
  );
  const reader = await nativeDirectory(invoke as never, 42);
  const signal = new AbortController();
  const pending = reader.next(signal.signal);
  await expect(reader.next()).rejects.toThrow("already");
  signal.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await expect(reader.next()).rejects.toThrow("closed");
  reading.resolve(page);
  cleanup.resolve();
  await reader.close();
  expect(
    invoke.mock.calls.filter(([command]) => command === "close_directory"),
  ).toHaveLength(1);
  const failure = vi.fn(async (command: string) => {
    if (command === "close_directory") throw new Error("cleanup unconfirmed");
    return "second";
  });
  const second = await nativeDirectory(failure as never, 42);
  await expect(second.close()).rejects.toThrow("unconfirmed");
  await expect(second.close()).rejects.toThrow("unconfirmed");
  expect(
    failure.mock.calls.filter(([command]) => command === "close_directory"),
  ).toHaveLength(1);
});
