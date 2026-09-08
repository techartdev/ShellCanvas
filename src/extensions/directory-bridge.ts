// SPDX-License-Identifier: MPL-2.0
import type { Directory } from "../sdk";
import type { AppFileSource, AppFileSourceGetter } from "./file-bridge";
import { RpcError, type Json, type RpcMethod } from "./rpc";

interface Listing {
  source: AppFileSource;
  directory?: Directory;
  offset: number;
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
/** Per-window snapshots. The existing backend materializes a directory; the wire is paged. */
export class AppDirectories {
  private listings = new Map<string, Listing>();
  private closed = false;
  private pending = 0;
  constructor(private source: AppFileSourceGetter) {}
  close() {
    this.closed = true;
    this.listings.clear();
  }
  refresh(connected = true) {
    const current = this.source();
    for (const [id, listing] of this.listings)
      if (
        !connected ||
        !current ||
        current.binding !== listing.source.binding ||
        current.services !== listing.source.services
      )
        this.listings.delete(id);
  }
  private page(id: string, listing: Listing): Json {
    const directory = listing.directory!;
    const { entries, ...metadata } = directory;
    const page: Directory = { ...metadata, entries: [] };
    let size = JSON.stringify(metadata).length;
    if (size > 1024 * 1024)
      throw new RpcError(
        "failed",
        "Directory metadata exceeds the page envelope.",
      );
    while (listing.offset < entries.length && page.entries.length < 128) {
      const entry = entries[listing.offset];
      const length = JSON.stringify(entry).length + 1;
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
    const done = listing.offset === entries.length;
    if (done) this.listings.delete(id);
    return JSON.parse(
      JSON.stringify({
        directory: { ...page, binding: listing.source.binding },
        done,
      }),
    ) as Json;
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
          if (
            this.pending +
              [...this.listings.values()].filter((item) => item.directory)
                .length >=
            16
          )
            throw new RpcError(
              "busy",
              "Close an existing directory listing before opening another.",
            );
          const listing: Listing = { source: captured, offset: 0 };
          this.listings.set(args.id, listing);
          this.pending++;
          try {
            const result = await captured.services.list(args.path ?? undefined);
            this.refresh();
            if (
              signal.aborted ||
              this.closed ||
              this.listings.get(args.id) !== listing
            )
              throw new RpcError(
                signal.aborted ? "aborted" : "closed",
                "Directory listing ended before it could be delivered.",
              );
            listing.directory = structuredClone(result);
            return this.page(args.id, listing);
          } catch (error) {
            if (this.listings.get(args.id) === listing)
              this.listings.delete(args.id);
            if (error instanceof RpcError) throw error;
            throw new RpcError(
              "failed",
              (error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : "Directory listing failed."
              ).slice(0, 4096),
            );
          } finally {
            this.pending--;
          }
        }),
      ],
      [
        "system.files.listNext",
        method(["files.read"], (value, signal) => {
          const { id } = parameters(value, ["id"]);
          this.refresh();
          const listing = this.listings.get(id);
          if (signal.aborted) {
            this.listings.delete(id);
            throw new RpcError("aborted", "Directory listing canceled.");
          }
          if (this.closed || !listing)
            throw new RpcError("closed", "Directory listing has closed.");
          if (!listing.directory)
            throw new RpcError("busy", "Directory listing is still opening.");
          try {
            return this.page(id, listing);
          } catch (error) {
            this.listings.delete(id);
            throw error;
          }
        }),
      ],
      [
        "system.files.listClose",
        method([], (value) => {
          const { id } = parameters(value, ["id"]);
          this.listings.delete(id);
          return null;
        }),
      ],
    ]);
  }
}
