// SPDX-License-Identifier: MPL-2.0
import { invoke } from "@tauri-apps/api/core";
import {
  defaultAdapterServices,
  type AdapterServices,
  type Configuration,
} from "../adapters";
import {
  createNativeCustomServices,
  type CustomBackend,
} from "../custom-services";
import type { Session } from "../sdk";
import type { NativeAdapterPin } from "./catalog";
import { customMethods } from "./custom-bridge";
import { emptyOptions } from "./environment";
import { RpcError, type Json, type RpcMethod } from "./rpc";

export interface CompanionBackend {
  adapters: Pick<AdapterServices, "list" | "connect">;
  services(session: Session): CustomBackend;
  disconnect(id: number): Promise<void>;
}
export const nativeCompanionBackend: CompanionBackend | undefined =
  defaultAdapterServices && {
    adapters: defaultAdapterServices,
    services: (session) =>
      createNativeCustomServices({
        sessionId: session.id,
        sources: session.customSources ?? {},
      }),
    disconnect: (sessionId) => invoke("disconnect", { sessionId }),
  };

/** One window owns one explicit connector session. It cannot name an adapter or borrow a host session. */
export class AppCompanion {
  private current?: {
    session: Session;
    backend: CustomBackend;
    binding: string;
  };
  private connecting?: AbortController;
  private lifetime = new AbortController();
  private closed = false;
  constructor(
    private pin: NativeAdapterPin,
    private grants: readonly string[],
    private backend: CompanionBackend,
    private changed: () => void,
  ) {}
  private check() {
    if (this.closed)
      throw new RpcError("closed", "This app window has closed.");
  }
  private status(): Json {
    return {
      connected: !!this.current,
      binding: this.current?.binding ?? null,
    };
  }
  private async disconnect() {
    const old = this.current;
    this.current = undefined;
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.changed();
    if (old) await this.backend.disconnect(old.session.id);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.connecting?.abort();
    await this.disconnect();
  }
  methods(): Map<string, RpcMethod> {
    const bridge = customMethods(
      {
        list: async (signal) => {
          const owner = this.current;
          if (!owner) return [];
          const result = await owner.backend.list(owner.session.id, signal);
          if (this.current !== owner)
            throw new RpcError("closed", "Database connection changed.");
          return result;
        },
        call: async (binding, method, params, signal) => {
          const owner = this.current;
          if (!owner) throw new RpcError("closed", "Connect a database first.");
          const result = await owner.backend.call(
            owner.session.id,
            binding,
            method,
            params,
            AbortSignal.any([
              this.lifetime.signal,
              ...(signal ? [signal] : []),
            ]),
          );
          if (this.current !== owner)
            throw new RpcError(
              "closed",
              "Connection changed; inspect the query outcome before retrying.",
            );
          return result;
        },
      },
      this.grants,
      () => !!this.current && !this.closed,
    );
    return new Map<string, RpcMethod>([
      [
        "system.companion.status",
        {
          grants: [],
          invoke: (params) => {
            emptyOptions(params);
            this.check();
            return this.status();
          },
        },
      ],
      [
        "system.companion.list",
        {
          grants: [],
          invoke: async (params, signal) => {
            emptyOptions(params);
            this.check();
            return (await bridge.list(signal)) as unknown as Json;
          },
        },
      ],
      ["system.companion.call", bridge.call],
      [
        "system.companion.disconnect",
        {
          grants: [],
          invoke: async (params) => {
            emptyOptions(params);
            this.check();
            this.connecting?.abort();
            await this.disconnect();
            return null;
          },
        },
      ],
      [
        "system.companion.connect",
        {
          grants: [],
          invoke: async (params, signal) => {
            this.check();
            if (!this.grants.some((grant) => grant.startsWith("services.")))
              throw new RpcError(
                "denied",
                "Grant this app its database service permission in App Manager.",
              );
            if (this.connecting)
              throw new RpcError(
                "busy",
                "A connection attempt is already running.",
              );
            if (
              !params ||
              typeof params !== "object" ||
              Array.isArray(params) ||
              Object.keys(params).some((key) => key !== "configuration") ||
              !params.configuration ||
              typeof params.configuration !== "object" ||
              Array.isArray(params.configuration)
            )
              throw new RpcError(
                "invalid",
                "Supply connection configuration only.",
              );
            const controller = new AbortController();
            this.connecting = controller;
            const combined = AbortSignal.any([
              signal,
              controller.signal,
              AbortSignal.timeout(45000),
            ]);
            try {
              const adapter = (await this.backend.adapters.list()).find(
                (item) => item.id === this.pin.id,
              );
              if (!adapter?.enabled || adapter.digest !== this.pin.digest)
                throw new RpcError(
                  "unavailable",
                  "The approved connector is disabled or has changed. Review the app again in App Manager.",
                );
              const configuration: Configuration = {};
              for (const [key, value] of Object.entries(params.configuration)) {
                const field = adapter.configuration.find(
                  (field) => field.id === key,
                );
                const kind =
                  field?.kind === "password"
                    ? "string"
                    : field?.kind === "text"
                      ? "string"
                      : field?.kind;
                if (
                  !field ||
                  typeof value !== kind ||
                  (typeof value === "string" && value.length > 8192) ||
                  (typeof value === "number" && !Number.isFinite(value))
                )
                  throw new RpcError(
                    "invalid",
                    "Invalid connector configuration field.",
                  );
                configuration[key] = value as string | number | boolean;
              }
              combined.throwIfAborted();
              const session = await this.backend.adapters.connect(
                {
                  name: adapter.name,
                  sources: [
                    {
                      key: "companion",
                      id: adapter.id,
                      revision: adapter.revision,
                      configuration,
                    },
                  ],
                  bindings: Object.fromEntries(
                    this.grants
                      .filter((grant) => grant.startsWith("services."))
                      .map((grant) => [grant.slice(9), "companion"]),
                  ),
                },
                combined,
              );
              if (this.closed || combined.aborted) {
                await this.backend.disconnect(session.id);
                throw new RpcError("aborted", "Connection canceled.");
              }
              const old = this.current;
              this.lifetime.abort();
              this.lifetime = new AbortController();
              this.current = {
                session,
                backend: this.backend.services(session),
                binding: crypto.randomUUID(),
              };
              this.changed();
              if (old) await this.backend.disconnect(old.session.id);
              return this.status();
            } finally {
              if (this.connecting === controller) this.connecting = undefined;
            }
          },
        },
      ],
    ]);
  }
}
