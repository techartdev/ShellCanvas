// SPDX-License-Identifier: MPL-2.0
import type {
  FileEntry,
  FileRelocation,
  SessionServices,
  TransferTicket,
} from "./sdk";

export interface CutItem {
  readonly entry: Readonly<FileEntry>;
  readonly parent: string;
}
interface Snapshot {
  readonly systemSequence?: number;
  readonly copies?: readonly CutItem[];
  readonly item: CutItem | null;
  readonly working: boolean;
  readonly error: string;
}

/** In-memory remote objects; deliberately separate from the OS text clipboard. */
class FileClipboard {
  private state: Snapshot = { item: null, working: false, error: "" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private preparation = 0;
  private active = true;
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
    this.state = state;
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
      entries.length > 16 ||
      entries.some(
        (entry) => entry.kind !== "file" || !entry.path || !entry.revision,
      ) ||
      new Set(entries.map((entry) => entry.path)).size !== entries.length
    )
      throw new Error(
        "Select up to 16 regular files with current revisions to copy.",
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
    if (!this.state.working)
      this.publish({ item: null, working: false, error: "" });
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
    const { item, working } = this.state;
    if (!this.active || !item)
      throw new Error("Cut an item in this workspace first.");
    if (working) throw new Error("A clipboard move is already running.");
    if (!parent || parent === item.parent || parent === item.entry.path)
      throw new Error("Choose a different destination folder.");
    const generation = this.generation;
    this.publish({ item, working: true, error: "" });
    try {
      const result = await this.services.moveEntry(
        item.entry.path,
        parent,
        item.entry.revision!,
      );
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
