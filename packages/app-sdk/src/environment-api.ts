// SPDX-License-Identifier: MPL-2.0
import type { Json } from "./rpc.js";
export interface AppEnvironment {
  readonly apiVersion: 1;
  readonly connection:
    "local" | "connected" | "disconnected" | "review-required";
  /** Opaque identity of the explicitly accepted binding, never a native session handle. */
  readonly binding: string | null;
  readonly visible: boolean;
  readonly capabilities: readonly string[];
}
export interface ServiceMethodInfo {
  readonly name: string;
  readonly version: 1;
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
