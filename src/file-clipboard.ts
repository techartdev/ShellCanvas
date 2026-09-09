// SPDX-License-Identifier: MPL-2.0
import type {
  FileEntry,
  FileRelocation,
  SessionServices,
  TransferTicket,
} from "./sdk";
import { TransferCleanupError } from "./transfer-errors";

export interface CutItem {
  readonly entry: Readonly<FileEntry>;
  readonly parent: string;
}
interface Snapshot {
  readonly systemSequence?: number;
  readonly copies?: readonly CutItem[];
  readonly item: CutItem | null;
  readonly working: boolean;
  readonly cleanupPending?: boolean;
  readonly error: string;
}

/** In-memory remote objects; deliberately separate from the OS text clipboard. */
class FileClipboard {
  private state: Snapshot = { item: null, working: false, error: "" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private preparation = 0;
  private active = true;
  private pendingMoveCleanup = new Set<number>();
  constructor(private services: SessionServices) {}
  snapshot = () => this.state;
  syncSystem(sequence: number) {
    if (this.active) this.publish({ ...this.state, systemSequence: sequence });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: Snapshot) {
    this.state = { ...state, cleanupPending: this.pendingMoveCleanup.size > 0 };
    this.listeners.forEach((listener) => listener());
  }
  activate() {
    this.active = true;
  }
  dispose() {
    this.active = false;
    ++this.generation;
    ++this.preparation;
    this.publish({ item: null, working: false, error: "" });
  }
  cut(entry: FileEntry, parent: string) {
    if (!this.active || this.state.working) return;
    if (!entry.path || !parent || !entry.revision)
      throw new Error("Refresh the folder before cutting this item.");
    ++this.generation;
    this.publish({
      item: Object.freeze({ entry: Object.freeze({ ...entry }), parent }),
      working: false,
      error: "",
    });
  }
  copy(entries: FileEntry[], parent: string) {
    if (!this.active || this.state.working) return;
    if (
      !parent ||
      !entries.length ||
      entries.some(
        (entry) =>
          !["file", "directory"].includes(entry.kind) ||
          !entry.path ||
          !entry.revision,
      ) ||
      new Set(entries.map((entry) => entry.path)).size !== entries.length
    )
      throw new Error(
        "Select files or folders with current revisions to copy.",
      );
    ++this.generation;
    this.publish({
      item: null,
      copies: Object.freeze(
        entries.map((entry) =>
          Object.freeze({ parent, entry: Object.freeze({ ...entry }) }),
        ),
      ),
      working: false,
      error: "",
    });
  }
  async prepareCopies(
    parent: string,
    services: SessionServices,
  ): Promise<TransferTicket[]> {
    const copies = this.state.copies;
    if (!this.active || !copies?.length)
      throw new Error("Copy files in this workspace first.");
    if (this.state.working)
      throw new Error("Clipboard work is already running.");
    if (
      !parent ||
      copies.some(
        (item) => item.parent === parent || item.entry.path === parent,
      )
    )
      throw new Error("Choose a different destination folder.");
    const generation = this.generation;
    const preparation = ++this.preparation;
    const tickets: TransferTicket[] = [];
    this.publish({ ...this.state, working: true, error: "" });
    try {
      if (services.prepareCopySelection) {
        tickets.push(
          await services.prepareCopySelection(
            copies.map(({ entry }) => ({
              path: entry.path,
              revision: entry.revision!,
            })),
            parent,
          ),
        );
      } else {
        for (const item of copies) {
          if (!this.active || generation !== this.generation)
            throw new Error(
              "The copied files or connection changed. Copy them again.",
            );
          tickets.push(
            await services.prepareCopy(
              item.entry.path,
              item.entry.revision!,
              parent,
            ),
          );
        }
      }
      if (!this.active || generation !== this.generation)
        throw new Error(
          "The copied files or connection changed. Copy them again.",
        );
      this.publish({ ...this.state, working: false });
      return tickets;
    } catch (error) {
      const cleanup = await Promise.allSettled(
        tickets.map((ticket) => services.cancelTransfer(ticket.id)),
      );
      const failures = cleanup.filter((result) => result.status === "rejected");
      const message = `${error}${failures.length ? `; ${failures.length} prepared transfers could not be canceled. Disconnect this workspace to release them.` : ""}`;
      if (this.active && generation === this.generation)
        this.publish({ ...this.state, working: false, error: message });
      else if (this.active && preparation === this.preparation)
        this.publish({ ...this.state, working: false });
      throw new Error(message);
    }
  }
  clear() {
    if (!this.state.working) {
      const { item, systemSequence } = this.state;
      const generation = ++this.generation;
      const cleanup = this.pendingMoveCleanup.size > 0;
      this.publish({ item: null, working: cleanup, error: "" });
      if (
        cleanup ||
        (item && systemSequence !== undefined && this.services.cancelSystemCut)
      )
        void (async () => {
          await this.releaseMoves();
          if (item && systemSequence !== undefined)
            await this.services.cancelSystemCut?.(systemSequence);
          if (cleanup && this.active && this.generation === generation)
            this.publish({ ...this.state, working: false });
        })().catch((error) => {
          if (this.active && this.generation === generation)
            this.publish({
              ...this.state,
              item,
              systemSequence,
              working: false,
              error: `Could not cancel the system cut: ${error}`,
            });
        });
    }
  }
  private async releaseMoves() {
    for (const id of this.pendingMoveCleanup) {
      await this.services.cancelTransfer(id);
      this.pendingMoveCleanup.delete(id);
    }
  }
  private async nativeMove(parent: string, sequence: number): Promise<string> {
    await this.releaseMoves();
    const tickets = await this.services.pasteMovedFiles!(parent, sequence);
    for (const ticket of tickets) this.pendingMoveCleanup.add(ticket.id);
    if (tickets.length !== 1 || tickets[0].direction !== "move") {
      await this.releaseMoves();
      throw new Error("Invalid clipboard move preparation");
    }
    const ticket = tickets[0];
    let keepForCleanup = false;
    try {
      const outcome = await this.services.runTransfer(ticket, () => {});
      if (outcome.status !== "completed" || !outcome.path)
        throw new Error(
          outcome.message ||
            "Move did not complete. Refresh before cutting again.",
        );
      return outcome.path;
    } catch (error) {
      keepForCleanup = error instanceof TransferCleanupError;
      throw error;
    } finally {
      if (!keepForCleanup) this.pendingMoveCleanup.delete(ticket.id);
    }
  }
  removed(path: string) {
    if (this.state.copies?.some((item) => item.entry.path === path)) {
      ++this.generation;
      this.publish({
        item: null,
        working: this.state.working,
        error: "Copied files changed. Select and copy them again.",
      });
    }
    if (this.state.item?.entry.path === path)
      this.publish({ ...this.state, item: null, error: "" });
  }
  trackedPaths() {
    if (this.state.copies)
      return [
        ...new Set(
          this.state.copies.flatMap((item) => [item.entry.path, item.parent]),
        ),
      ];
    const item = this.state.item;
    return item ? [item.entry.path, item.parent] : [];
  }
  relocated(result: FileRelocation) {
    if (
      this.state.copies?.some((item) =>
        result.locations.some(
          ({ previous }) =>
            previous === item.entry.path || previous === item.parent,
        ),
      )
    ) {
      ++this.generation;
      this.publish({
        item: null,
        working: this.state.working,
        error: "Copied files moved. Select and copy them again.",
      });
    }
    const item = this.state.item;
    // Mappings do not carry a new revision: never silently retarget a cut.
    if (
      item &&
      result.locations.some(
        ({ previous }) =>
          previous === item.entry.path || previous === item.parent,
      )
    ) {
      this.publish({ ...this.state, item: null, error: "" });
    }
  }
  async paste(parent: string): Promise<string> {
    const { item, working, systemSequence } = this.state;
    if (!this.active || !item)
      throw new Error("Cut an item in this workspace first.");
    if (working) throw new Error("A clipboard move is already running.");
    if (!parent || parent === item.parent || parent === item.entry.path)
      throw new Error("Choose a different destination folder.");
    return this.performMove(() =>
      systemSequence !== undefined && this.services.pasteMovedFiles
        ? this.nativeMove(parent, systemSequence)
        : this.services.moveEntry(
            item.entry.path,
            parent,
            item.entry.revision!,
          ),
    );
  }
  async pasteSystem(parent: string, sequence: number): Promise<string> {
    if (!this.services.pasteMovedFiles)
      throw new Error("Native clipboard moves are unavailable");
    return this.performMove(() => this.nativeMove(parent, sequence));
  }
  private async performMove(run: () => Promise<string>): Promise<string> {
    if (!this.active) throw new Error("Workspace clipboard is closed");
    if (this.state.working)
      throw new Error("A clipboard operation is already running");
    const generation = ++this.generation;
    this.publish({ ...this.state, working: true, error: "" });
    try {
      const result = await run();
      if (!this.active || this.generation !== generation)
        throw new Error(
          "Connection changed before the move was confirmed. Verify the destination before retrying.",
        );
      this.publish({ item: null, working: false, error: "" });
      return result;
    } catch (error) {
      if (this.active && this.generation === generation)
        this.publish({ ...this.state, working: false, error: String(error) });
      throw error;
    }
  }
}

// One clipboard per fixed service binding, never indexed by a host name or path.
const clipboards = new WeakMap<SessionServices, FileClipboard>();
/** Shell-only alias for a declared move-capable app in the same workspace. */
export function shareFileClipboard(
  source: SessionServices,
  target: SessionServices,
) {
  clipboards.set(target, fileClipboard(source));
}
export function fileClipboard(services: SessionServices) {
  let clipboard = clipboards.get(services);
  if (!clipboard) {
    clipboard = new FileClipboard(services);
    clipboards.set(services, clipboard);
  }
  return clipboard;
}
