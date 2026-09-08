// SPDX-License-Identifier: MPL-2.0
import type { FileEntry, FileRelocation, SessionServices } from "./sdk";

export interface CutItem {
  readonly entry: Readonly<FileEntry>;
  readonly parent: string;
}
interface Snapshot {
  readonly item: CutItem | null;
  readonly working: boolean;
  readonly error: string;
}

/** In-memory remote objects; deliberately separate from the OS text clipboard. */
class FileClipboard {
  private state: Snapshot = { item: null, working: false, error: "" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = true;
  constructor(private services: SessionServices) {}
  snapshot = () => this.state;
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
  clear() {
    if (!this.state.working)
      this.publish({ item: null, working: false, error: "" });
  }
  removed(path: string) {
    if (this.state.item?.entry.path === path)
      this.publish({ ...this.state, item: null, error: "" });
  }
  trackedPaths() {
    const item = this.state.item;
    return item ? [item.entry.path, item.parent] : [];
  }
  relocated(result: FileRelocation) {
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
