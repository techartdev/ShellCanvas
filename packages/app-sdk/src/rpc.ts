// SPDX-License-Identifier: MPL-2.0
/** Version 1 is JSON on an ordered, instance-owned channel, independent of transport. */
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type RpcCode =
  | "invalid"
  | "closed"
  | "aborted"
  | "denied"
  | "unavailable"
  | "busy"
  | "failed";
export class RpcError extends Error {
  constructor(
    public readonly code: RpcCode,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
export interface RpcTransport {
  send(message: string): void;
  subscribe(
    receive: (message: unknown) => void,
    disconnected: () => void,
  ): () => void;
  close(): void;
}
export interface RpcMethod {
  /** All static grants must be held. Dynamic dispatchers must check their target's grants in invoke. */
  grants: readonly string[];
  /** Operation support is independent of the permission to use a capability. */
  operations?: Readonly<Record<string, readonly string[]>>;
  /** Live availability may change; the operation handler and its owner remain pinned. */
  available?(): boolean;
  invoke(params: Json, signal: AbortSignal): Promise<Json> | Json;
}
type Envelope =
  | { v: 1; type: "request"; id: number; method: string; params: Json }
  | { v: 1; type: "cancel"; id: number }
  | { v: 1; type: "result"; id: number; value: Json }
  | { v: 1; type: "error"; id: number; code: RpcCode; message: string }
  | { v: 1; type: "close" };
const codes: readonly string[] = [
  "invalid",
  "closed",
  "aborted",
  "denied",
  "unavailable",
  "busy",
  "failed",
];
const maxMessage = 4 * 1024 * 1024;
const maxPending = 64;
const methodName = /^[a-z][a-z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/;

export function isJsonValue(value: unknown): value is Json {
  // Iterative validation keeps malformed/deep extension input off the recursive stack.
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > 64) return false;
    if (
      item.value === null ||
      typeof item.value === "string" ||
      typeof item.value === "boolean"
    )
      continue;
    if (typeof item.value === "number" && Number.isFinite(item.value)) continue;
    if (typeof item.value !== "object" || item.value === null) return false;
    if (
      !Array.isArray(item.value) &&
      Object.getPrototypeOf(item.value) !== Object.prototype
    )
      return false;
    for (const child of Object.values(item.value))
      pending.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}
function encode(value: Envelope): string {
  if (!isJsonValue(value))
    throw new RpcError(
      "invalid",
      "Only finite JSON values with at most 64 nesting levels are supported.",
    );
  const text = JSON.stringify(value);
  if (text.length > maxMessage)
    throw new RpcError(
      "invalid",
      "RPC message exceeds 4 Mi UTF-16 units; stream bulk data separately.",
    );
  return text;
}
function decode(raw: unknown): Envelope {
  if (typeof raw !== "string" || raw.length > maxMessage)
    throw new RpcError("invalid", "Invalid RPC message.");
  const value: unknown = JSON.parse(raw);
  if (
    !isJsonValue(value) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.v !== 1
  )
    throw new RpcError("invalid", "Unsupported RPC envelope.");
  if (value.type === "close") return { v: 1, type: "close" };
  const id = value.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    throw new RpcError("invalid", "Invalid request identity.");
  if (
    value.type === "request" &&
    typeof value.method === "string" &&
    methodName.test(value.method) &&
    Object.hasOwn(value, "params")
  )
    return {
      v: 1,
      type: "request",
      id,
      method: value.method,
      params: value.params,
    };
  if (value.type === "cancel") return { v: 1, type: "cancel", id };
  if (value.type === "result" && Object.hasOwn(value, "value"))
    return { v: 1, type: "result", id, value: value.value };
  if (
    value.type === "error" &&
    typeof value.code === "string" &&
    codes.includes(value.code) &&
    typeof value.message === "string"
  )
    return {
      v: 1,
      type: "error",
      id,
      code: value.code as RpcCode,
      message: value.message,
    };
  throw new RpcError("invalid", "Invalid RPC envelope.");
}

/** A peer belongs to one instance/generation. Never rebind its transport or handlers. */
export class RpcPeer {
  private closed = false;
  private serial = 0;
  private received = 0;
  private unsubscribe: () => void = () => {};
  private pending = new Map<
    number,
    {
      resolve(value: Json): void;
      reject(error: RpcError): void;
      cleanup(): void;
    }
  >();
  private running = new Map<number, AbortController>();
  private methods: ReadonlyMap<string, RpcMethod>;
  private grants: Set<string>;
  private closeListeners = new Set<() => void>();
  constructor(
    private transport: RpcTransport,
    methods: ReadonlyMap<string, RpcMethod> = new Map(),
    grants: readonly string[] = [],
  ) {
    this.methods = new Map(
      [...methods].map(([name, method]) => {
        if (!methodName.test(name))
          throw new RpcError("invalid", `Invalid method name: ${name}`);
        return [
          name,
          {
            grants: [...method.grants],
            invoke: method.invoke,
            available: method.available,
          },
        ];
      }),
    );
    this.grants = new Set(grants);
    this.unsubscribe = transport.subscribe(
      (raw) => this.receive(raw),
      () =>
        this.finish(new RpcError("closed", "Extension channel disconnected.")),
    );
  }
  get isClosed() {
    return this.closed;
  }
  onClose(listener: () => void) {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  call(
    method: string,
    params: Json = null,
    signal?: AbortSignal,
  ): Promise<Json> {
    if (this.closed)
      return Promise.reject(
        new RpcError("closed", "Extension instance has closed."),
      );
    if (signal?.aborted)
      return Promise.reject(new RpcError("aborted", "Request canceled."));
    if (!methodName.test(method))
      return Promise.reject(new RpcError("invalid", "Invalid method name."));
    if (this.pending.size >= maxPending)
      return Promise.reject(new RpcError("busy", "Too many pending requests."));
    const id = ++this.serial;
    if (!Number.isSafeInteger(id)) {
      this.close();
      return Promise.reject(
        new RpcError("closed", "Request identities exhausted."),
      );
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        request.cleanup();
        reject(
          new RpcError(
            "aborted",
            "Request canceled; an already dispatched write may have completed.",
          ),
        );
        this.send({ v: 1, type: "cancel", id });
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.transport.send(
          encode({ v: 1, type: "request", id, method, params }),
        );
      } catch (error) {
        this.pending.get(id)?.cleanup();
        this.pending.delete(id);
        reject(
          error instanceof RpcError
            ? error
            : new RpcError("closed", "Unable to send request."),
        );
        if (!(error instanceof RpcError)) this.close();
      }
    });
  }
  /** Revocation retires the whole instance, so no outstanding operation keeps an old grant. */
  close() {
    if (this.closed) return;
    this.send({ v: 1, type: "close" });
    this.finish(new RpcError("closed", "Extension instance has closed."));
  }
  private finish(reason: RpcError) {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(reason);
    }
    this.pending.clear();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        /* One owner cannot prevent other cleanup. */
      }
    }
    this.closeListeners.clear();
    this.transport.close();
  }
  private send(value: Envelope) {
    if (this.closed) return;
    try {
      this.transport.send(encode(value));
    } catch {
      this.finish(new RpcError("closed", "Extension channel failed."));
    }
  }
  private receive(raw: unknown) {
    if (this.closed) return;
    let value: Envelope;
    try {
      value = decode(raw);
    } catch {
      this.close();
      return;
    }
    if (value.type === "close") {
      this.finish(new RpcError("closed", "Extension instance has closed."));
      return;
    }
    if (value.type === "cancel") {
      this.running.get(value.id)?.abort();
      return;
    }
    if (value.type === "result" || value.type === "error") {
      const request = this.pending.get(value.id);
      if (!request) return; // Canceled call or late reply; never reused by another instance.
      this.pending.delete(value.id);
      request.cleanup();
      if (value.type === "result") request.resolve(value.value);
      else request.reject(new RpcError(value.code, value.message));
      return;
    }
    if (value.id <= this.received) {
      this.close();
      return;
    } // Ordered transport; replay is a protocol violation.
    this.received = value.id;
    void this.dispatch(value);
  }
  private async dispatch(request: Extract<Envelope, { type: "request" }>) {
    const fail = (code: RpcCode, message: string) =>
      this.send({ v: 1, type: "error", id: request.id, code, message });
    const method = this.methods.get(request.method);
    if (!method) {
      fail("unavailable", "Unknown service method.");
      return;
    }
    if (method.grants.some((grant) => !this.grants.has(grant))) {
      fail("denied", "The extension does not hold the required permission.");
      return;
    }
    if (this.running.size >= maxPending) {
      fail("busy", "Too many active requests.");
      return;
    }
    const controller = new AbortController();
    this.running.set(request.id, controller);
    try {
      if (method.available && !method.available())
        throw new RpcError(
          "unavailable",
          "This service is currently unavailable.",
        );
      const result = await method.invoke(request.params, controller.signal);
      if (!this.closed && !controller.signal.aborted) {
        // A non-JSON provider result fails only this call, instead of dropping unrelated requests.
        encode({ v: 1, type: "result", id: request.id, value: result });
        this.send({ v: 1, type: "result", id: request.id, value: result });
      }
    } catch (error) {
      if (!controller.signal.aborted && !this.closed)
        fail(
          error instanceof RpcError ? error.code : "failed",
          error instanceof RpcError
            ? error.message
            : "Service operation failed.",
        );
    } finally {
      this.running.delete(request.id);
    }
  }
}

export function messagePortTransport(port: MessagePort): RpcTransport {
  return {
    send: (message) => port.postMessage(message),
    subscribe(receive, disconnected) {
      const message = (event: MessageEvent) => receive(event.data);
      port.addEventListener("message", message);
      port.addEventListener("messageerror", disconnected);
      port.start();
      return () => {
        port.removeEventListener("message", message);
        port.removeEventListener("messageerror", disconnected);
      };
    },
    close: () => port.close(),
  };
}
