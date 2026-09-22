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
import type { Session, ConnectionIdentity } from "../sdk";
import type { NativeAdapterPin } from "./catalog";
import { customMethods } from "./custom-bridge";
import { emptyOptions } from "./environment";
import { RpcError, type Json, type RpcMethod } from "./rpc";

export interface CompanionHost {
  sessionId: number;
  source: ConnectionIdentity;
}
export type CompanionHostGetter = () => CompanionHost | undefined;
type Tunnel = { port: number; close(): Promise<void> };
const hostKey = (host?: CompanionHost) =>
  host
    ? `${host.sessionId}:${host.source.instance}:${host.source.generation}`
    : undefined;
export interface CompanionBackend {
  adapters: Pick<AdapterServices, "list" | "connect">;
  services(session: Session): CustomBackend;
  disconnect(id: number): Promise<void>;
  tunnel?(source: CompanionHost, host: string, port: number): Promise<Tunnel>;
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
    tunnel: async (source, host, port) => {
      const endpoint = await invoke<{ id: string; port: number }>(
        "app_tunnel_open",
        { ...source, host, port },
      );
      return {
        port: endpoint.port,
        close: () => invoke("app_tunnel_close", { id: endpoint.id }),
      };
    },
  };

/** One window owns its connector and tunnel. Host identities come only from the trusted desktop. */
export class AppCompanion {
  private current?: {
    session: Session;
    backend: CustomBackend;
    binding: string;
    host?: string;
    tunnel?: Tunnel;
  };
  private connecting?: AbortController;
  private lifetime = new AbortController();
  private closed = false;
  private pendingHost?: string;
  constructor(
    private pin: NativeAdapterPin,
    private grants: readonly string[],
    private backend: CompanionBackend,
    private changed: () => void,
    private host: CompanionHostGetter = () => undefined,
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
    if (old) await this.dispose(old);
  }
  private async dispose(owner: NonNullable<AppCompanion["current"]>) {
    try {
      await owner.tunnel?.close();
    } finally {
      await this.backend.disconnect(owner.session.id);
    }
  }
  async refreshHost() {
    const key = hostKey(this.host());
    if (this.pendingHost && key !== this.pendingHost) this.connecting?.abort();
    if (this.current?.host && key !== this.current.host)
      await this.disconnect();
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
          await this.refreshHost();
          const owner = this.current;
          if (!owner) return [];
          const result = await owner.backend.list(owner.session.id, signal);
          if (this.current !== owner)
            throw new RpcError("closed", "Database connection changed.");
          return result;
        },
        call: async (binding, method, params, signal) => {
          await this.refreshHost();
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
        "system.companion.routes",
        {
          grants: [],
          invoke: (params) => {
            emptyOptions(params);
            this.check();
            return {
              ssh:
                !!this.host() &&
                !!this.backend.tunnel &&
                this.grants.includes("host.tcp"),
            };
          },
        },
      ],
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
              Object.keys(params).some(
                (key) => key !== "configuration" && key !== "route",
              ) ||
              (params.route !== undefined &&
                params.route !== "ssh" &&
                params.route !== "direct") ||
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
            let tunnel: Tunnel | undefined;
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
                  key === "tcpProxyPort" ||
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
              let source: CompanionHost | undefined;
              if (params.route === "ssh") {
                if (!this.grants.includes("host.tcp"))
                  throw new RpcError(
                    "denied",
                    "Grant this app access to TCP services through the connected host in App Manager.",
                  );
                source = this.host();
                if (!source || !this.backend.tunnel)
                  throw new RpcError(
                    "unavailable",
                    "Connect an SSH host and accept its connection before opening a database.",
                  );
                if (
                  typeof configuration.host !== "string" ||
                  typeof configuration.port !== "number" ||
                  !Number.isInteger(configuration.port) ||
                  configuration.port < 1 ||
                  configuration.port > 65535 ||
                  !adapter.configuration.some(
                    (field) =>
                      field.id === "tcpProxyPort" && field.kind === "number",
                  )
                )
                  throw new RpcError(
                    "invalid",
                    "This connector does not support host TCP connections.",
                  );
                this.pendingHost = hostKey(source);
                tunnel = await this.backend.tunnel(
                  source,
                  configuration.host,
                  configuration.port,
                );
                combined.throwIfAborted();
                if (hostKey(this.host()) !== this.pendingHost)
                  throw new RpcError(
                    "closed",
                    "The SSH host connection changed. Connect again after accepting the host.",
                  );
                configuration.tcpProxyPort = tunnel.port;
              }
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
              if (
                this.closed ||
                combined.aborted ||
                (source && hostKey(this.host()) !== hostKey(source))
              ) {
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
                host: hostKey(source),
                tunnel,
              };
              tunnel = undefined;
              this.changed();
              if (old) await this.dispose(old);
              return this.status();
            } catch (error) {
              if (error instanceof RpcError) throw error;
              if (combined.aborted)
                throw new RpcError(
                  "aborted",
                  signal.aborted || controller.signal.aborted
                    ? "Connection canceled."
                    : "Connection timed out. Check the database host, TCP port and network access.",
                );
              // Native commands reject with public error strings. Convert them at
              // this boundary so RPC does not replace them with its generic error.
              const detail =
                typeof error === "string"
                  ? error
                  : error instanceof Error
                    ? error.message
                    : "The native connector could not establish a connection.";
              throw new RpcError(
                "failed",
                detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1500),
              );
            } finally {
              await tunnel?.close();
              this.pendingHost = undefined;
              if (this.connecting === controller) this.connecting = undefined;
            }
          },
        },
      ],
    ]);
  }
}
