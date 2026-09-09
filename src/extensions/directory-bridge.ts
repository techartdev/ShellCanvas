// SPDX-License-Identifier: MPL-2.0
import type { Directory, DirectoryPage, DirectoryReader } from "../sdk";
import { snapshotDirectory } from "../directory-reader";
import type { AppFileSource, AppFileSourceGetter } from "./file-bridge";
import { RpcError, type Json, type RpcMethod } from "./rpc";

interface Listing {
  source: AppFileSource;
  controller: AbortController;
  reader?: DirectoryReader;
  batch?: DirectoryPage;
  offset: number;
  busy: boolean;
  retired: boolean;
  cleanup?: Promise<void>;
  cleaned?: boolean;
}
function parameters(value: Json, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)
  )
    throw new RpcError("invalid", "Invalid directory request.");
  return value as { id: string; [key: string]: Json };
}
/** Per-window scans. At most one provider page is buffered per reader. */
export class AppDirectories {
  private listings = new Map<string, Listing>();
  private active = new Set<Listing>();
  private closed = false;
  constructor(private source: AppFileSourceGetter) {}
  private retire(id: string, listing: Listing): Promise<void> {
    listing.retired = true;
    listing.batch = undefined;
    if (this.listings.get(id) === listing) this.listings.delete(id);
    listing.controller.abort();
    if (listing.reader) {
      return (listing.cleanup ??= listing.reader.close().finally(() => {
        listing.cleaned = true;
        if (!listing.busy) this.active.delete(listing);
      }));
    }
    // Keep capacity charged until a canceled opening returns its late reader.
    if (!listing.busy) this.active.delete(listing);
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    for (const [id, listing] of this.listings)
      void this.retire(id, listing).catch(() => {});
  }
  refresh(connected = true) {
    const current = this.source();
    for (const [id, listing] of this.listings) {
      if (
        !connected ||
        !current ||
        current.binding !== listing.source.binding ||
        current.services !== listing.source.services
      )
        void this.retire(id, listing).catch(() => {});
    }
  }
  private check(id: string, listing: Listing, signal: AbortSignal) {
    this.refresh();
    if (signal.aborted)
      throw new RpcError("aborted", "Directory listing canceled.");
    if (this.closed || listing.retired || this.listings.get(id) !== listing)
      throw new RpcError(
        "closed",
        "Directory listing ended before it could be delivered.",
      );
  }
  private async read(
    id: string,
    listing: Listing,
    signal: AbortSignal,
    path?: string,
  ): Promise<Json> {
    listing.busy = true;
    const abort = () => {
      void this.retire(id, listing).catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.check(id, listing, signal);
      if (!listing.reader) {
        const services = listing.source.services;
        listing.reader = services.openDirectory
          ? await services.openDirectory(path, listing.controller.signal)
          : await snapshotDirectory(
              () => services.list(path),
              listing.controller.signal,
            );
        this.check(id, listing, signal);
      }
      if (
        !listing.batch ||
        listing.offset === listing.batch.directory.entries.length
      ) {
        listing.batch = await listing.reader.next(listing.controller.signal);
        listing.offset = 0;
        this.check(id, listing, signal);
        if (
          listing.batch.directory.entries.length > 128 ||
          (!listing.batch.done && !listing.batch.directory.entries.length)
        )
          throw new RpcError("failed", "Invalid directory page.");
      }
      const batch = listing.batch;
      const { entries, ...metadata } = batch.directory;
      const page: Directory = { ...metadata, entries: [] };
      const bytes = (value: unknown) =>
        new TextEncoder().encode(JSON.stringify(value)).length;
      let size = bytes({
        directory: {
          ...metadata,
          binding: listing.source.binding,
          entries: [],
        },
        done: false,
      });
      if (size > 1024 * 1024)
        throw new RpcError(
          "failed",
          "Directory metadata exceeds the page envelope.",
        );
      while (listing.offset < entries.length && page.entries.length < 128) {
        const entry = entries[listing.offset];
        const length = bytes(entry) + 1;
        if (size + length > 1024 * 1024) {
          if (!page.entries.length)
            throw new RpcError(
              "failed",
              "A directory entry exceeds the page envelope.",
            );
          break;
        }
        page.entries.push(entry);
        size += length;
        listing.offset++;
      }
      const done = batch.done && listing.offset === entries.length;
      const result = JSON.parse(
        JSON.stringify({
          directory: { ...page, binding: listing.source.binding },
          done,
        }),
      ) as Json;
      if (done) {
        try {
          await this.retire(id, listing);
        } catch {
          throw new RpcError(
            "failed",
            "Directory cleanup could not be confirmed.",
          );
        }
        const current = this.source();
        if (
          signal.aborted ||
          this.closed ||
          !current ||
          current.binding !== listing.source.binding ||
          current.services !== listing.source.services
        )
          throw new RpcError(
            signal.aborted ? "aborted" : "closed",
            "Directory listing has closed.",
          );
      }
      return result;
    } catch (error) {
      const reason = signal.aborted
        ? new RpcError("aborted", "Directory listing canceled.")
        : error instanceof RpcError
          ? error
          : listing.retired || this.closed
            ? new RpcError("closed", "Directory listing has closed.")
            : new RpcError(
                "failed",
                (error instanceof Error
                  ? error.message
                  : typeof error === "string"
                    ? error
                    : "Directory listing failed."
                ).slice(0, 4096),
              );
      await this.retire(id, listing).catch(() => {});
      throw reason;
    } finally {
      signal.removeEventListener("abort", abort);
      listing.busy = false;
      if (listing.retired && (!listing.reader || listing.cleaned))
        this.active.delete(listing);
    }
  }
  methods(): ReadonlyMap<string, RpcMethod> {
    const method = (
      grants: string[],
      invoke: RpcMethod["invoke"],
    ): RpcMethod => ({ grants, invoke });
    return new Map([
      [
        "system.files.listStart",
        method(["files.read"], async (value, signal) => {
          const args = parameters(value, ["id", "binding", "path"]);
          if (
            typeof args.binding !== "string" ||
            (args.path !== null && typeof args.path !== "string")
          )
            throw new RpcError(
              "invalid",
              "Supply a binding and an opaque location or null.",
            );
          this.refresh();
          if (this.closed)
            throw new RpcError("closed", "Directory owner closed.");
          if (signal.aborted)
            throw new RpcError("aborted", "Directory listing canceled.");
          const captured = this.source();
          if (!captured)
            throw new RpcError(
              "unavailable",
              "No file source in this workspace.",
            );
          if (captured.binding !== args.binding)
            throw new RpcError(
              "closed",
              "Directory location belongs to a previous connection.",
            );
          if (this.listings.has(args.id))
            throw new RpcError(
              "invalid",
              "Directory listing identity is already in use.",
            );
          if (this.active.size >= 16)
            throw new RpcError(
              "busy",
              "Close an existing directory listing before opening another.",
            );
          const listing: Listing = {
            source: captured,
            controller: new AbortController(),
            offset: 0,
            busy: false,
            retired: false,
          };
          this.listings.set(args.id, listing);
          this.active.add(listing);
          return this.read(
            args.id,
            listing,
            signal,
            (args.path as string | null) ?? undefined,
          );
        }),
      ],
      [
        "system.files.listNext",
        method(["files.read"], (value, signal) => {
          const { id } = parameters(value, ["id"]);
          this.refresh();
          const listing = this.listings.get(id);
          if (this.closed || !listing)
            throw new RpcError("closed", "Directory listing has closed.");
          if (signal.aborted) {
            void this.retire(id, listing).catch(() => {});
            throw new RpcError("aborted", "Directory listing canceled.");
          }
          if (listing.busy)
            throw new RpcError(
              "busy",
              "A directory page is already being read.",
            );
          return this.read(id, listing, signal);
        }),
      ],
      [
        "system.files.listClose",
        method([], async (value) => {
          const { id } = parameters(value, ["id"]);
          const listing = this.listings.get(id);
          if (listing) await this.retire(id, listing);
          return null;
        }),
      ],
    ]);
  }
}
