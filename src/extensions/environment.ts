// SPDX-License-Identifier: MPL-2.0
import { RpcError, type Json, type RpcMethod } from "./rpc";
import type { AppEnvironment, ServiceMethodInfo } from "./environment-api";

export class RuntimeEnvironment {
  private listeners = new Set<(state: AppEnvironment) => void>();
  private state: AppEnvironment;
  constructor(
    initial: AppEnvironment = {
      apiVersion: 1,
      connection: "local",
      binding: null,
      visible: true,
      capabilities: [],
    },
  ) {
    this.state = structuredClone(initial);
  }
  snapshot = () => structuredClone(this.state);
  update(next: AppEnvironment) {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = structuredClone(next);
    for (const listener of this.listeners) listener(this.snapshot());
  }
  subscribe(listener: (state: AppEnvironment) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
export function discoverMethods(
  methods: ReadonlyMap<string, RpcMethod>,
  grants: readonly string[],
): readonly ServiceMethodInfo[] {
  return [...methods]
    .map(([name, method]): ServiceMethodInfo => ({
      name,
      version: 1,
      permissions: [...method.grants],
      granted: method.grants.every((grant) => grants.includes(grant)),
      available: method.available?.() ?? true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function emptyOptions(params: Json) {
  if (
    params !== null &&
    (!params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      Object.keys(params).length)
  )
    throw new RpcError("invalid", "This method takes no options.");
}
