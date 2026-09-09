// SPDX-License-Identifier: MPL-2.0
import type { Directory, DirectoryReader, SessionServices } from "./sdk";
import { directoryCanceled, snapshotDirectory } from "./directory-reader";

type Browser = Pick<SessionServices, "list" | "openDirectory">;
/** Resolve provider navigation without discovering the entire inventory. */
export async function directoryLocation(
  services: Browser,
  path?: string,
  signal?: AbortSignal,
): Promise<Omit<Directory, "entries">> {
  const reader = await openDirectory(services, path, signal);
  try {
    if (signal?.aborted) throw directoryCanceled();
    const { entries: _entries, ...location } = (await reader.next(signal))
      .directory;
    if (signal?.aborted) throw directoryCanceled();
    return location;
  } finally {
    await reader.close();
  }
}
export async function openDirectory(
  services: Browser,
  path?: string,
  signal?: AbortSignal,
): Promise<DirectoryReader> {
  return services.openDirectory
    ? services.openDirectory(path, signal)
    : snapshotDirectory(() => services.list(path), signal);
}

/** Progressive UI discovery. Keeps display metadata, never whole remote trees. */
export async function scanDirectory(
  services: Browser,
  path: string | undefined,
  signal: AbortSignal,
  publish: (directory: Directory, done: boolean) => void,
): Promise<void> {
  const check = () => {
    if (signal.aborted) throw directoryCanceled();
  };
  check();
  const reader = await openDirectory(services, path, signal);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= reader.close());
  const abort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let failure: unknown;
  try {
    check();
    const entries: Directory["entries"] = [];
    const positions = new Map<string, number>();
    let metadata: string | undefined;
    let published = -Infinity;
    let yielded = performance.now();
    while (true) {
      const page = await reader.next(signal);
      check();
      const { entries: batch, ...navigation } = page.directory;
      const identity = JSON.stringify(navigation);
      if (
        (metadata !== undefined && metadata !== identity) ||
        batch.length > 128 ||
        (!page.done && !batch.length)
      )
        throw new Error(
          "Directory changed during discovery. Refresh to start a new scan.",
        );
      metadata = identity;
      for (const entry of batch) {
        const position = positions.get(entry.path);
        if (position === undefined) {
          positions.set(entry.path, entries.length);
          entries.push(entry);
        } else entries[position] = entry;
      }
      const now = performance.now();
      if (page.done) {
        await close();
        check();
      }
      const delivered = page.done || now - published >= 50;
      if (delivered) {
        publish({ ...navigation, entries: entries.slice() }, page.done);
        published = now;
      }
      if (page.done) break;
      // Fast local adapters must still leave time for paint, input and cancellation.
      if (now - yielded >= 16 || published === now) {
        await new Promise<void>((resolve) => {
          const task = new MessageChannel();
          task.port1.onmessage = () => {
            task.port1.close();
            task.port2.close();
            resolve();
          };
          task.port2.postMessage(null);
        });
        check();
        yielded = performance.now();
        // Rendering cost must not cause another delivery immediately afterward.
        if (delivered) published = yielded;
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await close();
    } catch (error) {
      if (failure === undefined && !signal.aborted) throw error;
    }
  }
}
