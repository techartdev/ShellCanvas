// SPDX-License-Identifier: MPL-2.0
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Session } from "./sdk";
export type Configuration = Record<string, string | number | boolean>;
export interface AdapterField {
  id: string;
  label: string;
  kind: "text" | "password" | "number" | "boolean";
  required: boolean;
  default?: string | number | boolean | null;
}
export interface AdapterInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  platform: string;
  entrypoint: string;
  configuration: AdapterField[];
  generation: string;
  revision: string;
  enabled: boolean;
  fileCount: number;
  bytes: number;
}
export interface AdapterReview {
  requestId: string;
  package: AdapterInfo;
  replaces: boolean;
}
export interface AdapterSource {
  key: string;
  id: string;
  revision: string;
  configuration: Configuration;
}
export interface AdapterConnectionOptions {
  name: string;
  sources: AdapterSource[];
  bindings: Partial<Record<"files" | "console", string>>;
}
export interface AdapterProfile extends AdapterConnectionOptions {
  kind: "adapters";
}
export interface AdapterServices {
  list(): Promise<AdapterInfo[]>;
  review(requestId: string): Promise<AdapterReview | null>;
  cancelReview(requestId: string): Promise<void>;
  install(requestId: string): Promise<AdapterInfo>;
  setEnabled(
    id: string,
    revision: string,
    enabled: boolean,
  ): Promise<AdapterInfo>;
  remove(id: string, revision: string): Promise<void>;
  connect(
    options: AdapterConnectionOptions,
    signal?: AbortSignal,
  ): Promise<Session>;
}
export function adapterProfile(
  options: AdapterConnectionOptions,
  installed: readonly AdapterInfo[],
): AdapterProfile {
  return {
    kind: "adapters",
    name: options.name,
    bindings: { ...options.bindings },
    sources: options.sources.map((source) => {
      const adapter = installed.find(
        (item) => item.id === source.id && item.revision === source.revision,
      );
      if (!adapter)
        throw new Error(
          "The selected adapter changed. Refresh before connecting.",
        );
      const fields = new Set(
        adapter.configuration
          .filter((field) => field.kind !== "password")
          .map((field) => field.id),
      );
      return {
        ...source,
        configuration: Object.fromEntries(
          Object.entries(source.configuration).filter(([key]) =>
            fields.has(key),
          ),
        ),
      };
    }),
  };
}
export const nativeAdapterServices: AdapterServices = {
  list: () => invoke("list_adapters"),
  review: (requestId) => invoke("review_adapter", { requestId }),
  cancelReview: (requestId) => invoke("cancel_adapter_review", { requestId }),
  install: (requestId) => invoke("install_adapter", { requestId }),
  setEnabled: (id, revision, enabled) =>
    invoke("set_adapter_enabled", { id, revision, enabled }),
  remove: (id, revision) => invoke("remove_adapter", { id, revision }),
  async connect(options, signal) {
    if (signal?.aborted) throw new Error("Connection canceled");
    const requestId = await invoke<number>("begin_connect");
    const cancel = () => {
      void invoke("cancel_connect", { requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) throw new Error("Connection canceled");
      const result = await invoke<Session>("connect_adapters", {
        options,
        requestId,
      });
      if (signal?.aborted) {
        await invoke("disconnect", { sessionId: result.id });
        throw new Error("Connection canceled");
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancel();
    }
  },
};
export const defaultAdapterServices = isTauri()
  ? nativeAdapterServices
  : undefined;
