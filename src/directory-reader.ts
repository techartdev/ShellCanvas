// SPDX-License-Identifier: MPL-2.0
import type { Directory, DirectoryPage, DirectoryReader } from "./sdk";
export const directoryCanceled = () =>
  new DOMException("Directory listing canceled", "AbortError");

/** Compatibility only. Native services implement openDirectory without this snapshot. */
export async function snapshotDirectory(
  list: () => Promise<Directory>,
  signal?: AbortSignal,
): Promise<DirectoryReader> {
  if (signal?.aborted) throw directoryCanceled();
  let directory: Directory | undefined = structuredClone(await list());
  if (signal?.aborted) throw directoryCanceled();
  let offset = 0;
  const close = async () => {
    directory = undefined;
    signal?.removeEventListener("abort", abort);
  };
  const abort = () => {
    void close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  return {
    async next(readSignal) {
      if (readSignal?.aborted || signal?.aborted) {
        await close();
        throw directoryCanceled();
      }
      if (!directory) throw new Error("Directory reader is closed");
      const page = {
        ...directory,
        entries: directory.entries.slice(offset, offset + 128),
      };
      offset += page.entries.length;
      const done = offset === directory.entries.length;
      if (done) await close();
      return { directory: page, done };
    },
    close,
  };
}

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export async function nativeDirectory(
  invoke: Invoke,
  sessionId: number,
  path?: string,
  signal?: AbortSignal,
): Promise<DirectoryReader> {
  if (signal?.aborted) throw directoryCanceled();
  const directoryId = await invoke<string>("open_directory", {
    sessionId,
    path,
  });
  let closed = false,
    busy = false;
  let closing: Promise<void> | undefined;
  const args = { sessionId, directoryId };
  const close = (): Promise<void> => {
    closed = true;
    signal?.removeEventListener("abort", abort);
    return (closing ??= invoke<void>("close_directory", args));
  };
  const abort = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    await close();
    throw directoryCanceled();
  }
  return {
    async next(readSignal) {
      if (signal?.aborted || readSignal?.aborted) {
        abort();
        throw directoryCanceled();
      }
      if (closed) throw new Error("Directory reader is closed");
      if (busy) throw new Error("A directory page is already being read");
      busy = true;
      let onAbort = () => {};
      const canceled = new Promise<never>((_, reject) => {
        onAbort = () => {
          abort();
          reject(directoryCanceled());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        readSignal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const page = await Promise.race([
          invoke<DirectoryPage>("read_directory", args),
          canceled,
        ]);
        if (closed || signal?.aborted || readSignal?.aborted)
          throw directoryCanceled();
        if (page.done) {
          closed = true;
          signal?.removeEventListener("abort", abort);
        }
        return page;
      } catch (error) {
        abort();
        throw error;
      } finally {
        busy = false;
        signal?.removeEventListener("abort", onAbort);
        readSignal?.removeEventListener("abort", onAbort);
      }
    },
    close,
  };
}
