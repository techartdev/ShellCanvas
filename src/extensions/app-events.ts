// SPDX-License-Identifier: MPL-2.0
import { isJsonValue, RpcError, type Json, type RpcPeer } from "./rpc";
import type { AppEvent, AppEventBatch, AppEventsAPI } from "./environment-api";

/** Window-owned state events. Bounded history, explicit reset, no cross-instance topics. */
export class AppEventJournal {
  private serial = 0;
  private history: AppEvent[] = [];
  private latest = new Map<string, AppEvent>();
  private pending?: {
    after: number;
    resolve(batch: AppEventBatch): void;
    reject(error: unknown): void;
    cleanup(): void;
  };
  private retired = false;
  constructor(
    private topics: readonly string[],
    private capacity = 128,
  ) {
    if (
      topics.length > 64 ||
      new Set(topics).size !== topics.length ||
      topics.some(
        (topic) =>
          topic.length > 200 ||
          !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(topic),
      ) ||
      capacity < 1 ||
      capacity > 128 ||
      !Number.isInteger(capacity)
    )
      throw new Error("Invalid event journal configuration.");
    this.topics = [...topics];
  }
  publish(topic: string, value: Json) {
    if (this.retired) return;
    if (!this.topics.includes(topic) || !isJsonValue(value))
      throw new RpcError("invalid", "Invalid app event.");
    const serialized = JSON.stringify(value);
    if (serialized.length > 16384)
      throw new RpcError(
        "invalid",
        "State event exceeds its control-message budget.",
      );
    if (!Number.isSafeInteger(this.serial + 1)) {
      this.close();
      throw new RpcError("closed", "Event identities exhausted.");
    }
    const event: AppEvent = {
      sequence: ++this.serial,
      topic,
      value: JSON.parse(serialized) as Json,
    };
    this.latest.set(topic, event);
    this.history.push(event);
    if (this.history.length > this.capacity) this.history.shift();
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.cleanup();
      pending.resolve(this.batch(pending.after));
    }
  }
  private batch(after: number | null): AppEventBatch {
    const reset =
      after === null || after < (this.history[0]?.sequence ?? 1) - 1;
    return structuredClone({
      cursor: this.serial,
      reset,
      events: reset
        ? [...this.latest.values()].sort((a, b) => a.sequence - b.sequence)
        : this.history.filter((event) => event.sequence > after!),
    });
  }
  next(after: number | null, signal: AbortSignal): Promise<AppEventBatch> {
    if (this.retired)
      return Promise.reject(new RpcError("closed", "App events have closed."));
    if (signal.aborted)
      return Promise.reject(new RpcError("aborted", "Event wait canceled."));
    if (
      after !== null &&
      (!Number.isSafeInteger(after) || after < 0 || after > this.serial)
    )
      return Promise.reject(new RpcError("invalid", "Invalid event cursor."));
    if (after === null || after < this.serial)
      return Promise.resolve(this.batch(after));
    if (this.pending)
      return Promise.reject(
        new RpcError("busy", "An event read is already waiting."),
      );
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending = undefined;
        signal.removeEventListener("abort", abort);
        reject(new RpcError("aborted", "Event wait canceled."));
      };
      this.pending = {
        after,
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  close() {
    if (this.retired) return;
    this.retired = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.cleanup();
    pending?.reject(new RpcError("closed", "App events have closed."));
    this.history = [];
    this.latest.clear();
  }
}

/** SDK fan-out: subscriber errors and cancellation cannot break another component. */
export function appEventClient(peer: Pick<RpcPeer, "call">): AppEventsAPI {
  type Listener = {
    receive(batch: AppEventBatch): void | Promise<void>;
    error?(error: unknown): void;
  };
  const listeners = new Set<Listener>();
  const latest = new Map<string, AppEvent>();
  let cursor: number | null = null,
    controller: AbortController | undefined;
  const error = (listener: Listener, failure: unknown) => {
    try {
      listener.error?.(failure);
    } catch {
      /* An error listener cannot break the stream. */
    }
  };
  const deliver = (listener: Listener, batch: AppEventBatch) => {
    if (listeners.has(listener))
      try {
        void Promise.resolve(listener.receive(structuredClone(batch))).catch(
          (failure) => error(listener, failure),
        );
      } catch (failure) {
        error(listener, failure);
      }
  };
  const poll = async (active: AbortController) => {
    try {
      while (listeners.size && controller === active) {
        const batch = (await peer.call(
          "system.events.next",
          { after: cursor },
          active.signal,
        )) as unknown as AppEventBatch;
        if (controller !== active || active.signal.aborted) return;
        cursor = batch.cursor;
        if (batch.reset) latest.clear();
        for (const event of batch.events) latest.set(event.topic, event);
        for (const listener of [...listeners]) deliver(listener, batch);
      }
    } catch (failure) {
      if (controller !== active || active.signal.aborted) return;
      const stopped = [...listeners];
      listeners.clear();
      controller = undefined;
      latest.clear();
      cursor = null;
      for (const listener of stopped) error(listener, failure);
    }
  };
  return Object.freeze({
    subscribe(receive, onError) {
      const listener: Listener = { receive, error: onError };
      listeners.add(listener);
      if (!controller) {
        controller = new AbortController();
        void poll(controller);
      } else if (cursor !== null) {
        const snapshot: AppEventBatch = {
          cursor,
          reset: true,
          events: [...latest.values()].sort((a, b) => a.sequence - b.sequence),
        };
        queueMicrotask(() => deliver(listener, snapshot));
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          const previous = controller;
          controller = undefined;
          previous?.abort();
          cursor = null;
          latest.clear();
        }
      };
    },
  } satisfies AppEventsAPI);
}
