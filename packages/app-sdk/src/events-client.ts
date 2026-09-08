// SPDX-License-Identifier: MPL-2.0
import type { RpcPeer } from "./rpc.js";
import type {
  AppEvent,
  AppEventBatch,
  AppEventsAPI,
} from "./environment-api.js";
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
