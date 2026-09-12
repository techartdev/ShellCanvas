// SPDX-License-Identifier: MPL-2.0
import type { Json } from "./rpc.js";
import type { ClientEnvironment } from "./client-platform.js";
export interface AppEnvironment {
  readonly apiVersion: 1;
  /** Client target independent of the remote host. Absent on older ShellCanvas versions. */
  readonly client?: ClientEnvironment;
  /** Resolved desktop appearance; absent on older hosts. Colors are CSS hex values. */
  readonly appearance?: {
    readonly mode: "light" | "dark";
    readonly colors: Readonly<Record<string, string>>;
  };
  readonly connection:
    "local" | "connected" | "disconnected" | "review-required";
  /** Opaque identity of the explicitly accepted binding, never a native session handle. */
  readonly binding: string | null;
  /** Stable configured workspace identity across reconnects; not authentication
   * or routing authority. Null/absent means unknown. Compare opaque values only. */
  readonly workspaceId?: string | null;
  /** Display metadata only; never use labels as routing identities. */
  readonly host?: {
    readonly name: string;
    readonly system: string;
    /** Non-secret configured destination for distinguishing duplicate names. */
    readonly target?: string;
  };
  readonly visible: boolean;
  readonly capabilities: readonly string[];
  /** Optional supported operations within a capability; absent keys are legacy metadata. */
  readonly operations?: Readonly<Record<string, readonly string[]>>;
}
export interface ServiceMethodInfo {
  readonly name: string;
  readonly version: number;
  /** Opaque custom service binding; absent for built-in system methods. */
  readonly source?: string;
  readonly permissions: readonly string[];
  readonly granted: boolean;
  readonly available: boolean;
}
export interface AppEvent {
  readonly sequence: number;
  readonly topic: string;
  readonly value: Json;
}
export interface AppEventBatch {
  readonly cursor: number;
  /** Initial subscription or a slow reader: events contain current topic snapshots. */
  readonly reset: boolean;
  readonly events: readonly AppEvent[];
}
export interface AppEventsAPI {
  /** One underlying stream fans out to independent listeners. Unsubscribe is synchronous. */
  subscribe(
    listener: (batch: AppEventBatch) => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): () => void;
}
