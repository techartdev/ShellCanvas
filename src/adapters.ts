// SPDX-License-Identifier: MPL-2.0
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { HostKeyChallenge, HostKeyReviewer } from "./sdk";
import type { Session, ConnectionIdentity, WorkspaceStatus } from "./sdk";
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
  bindings: Record<string, string>;
}
export interface AdapterProfile extends AdapterConnectionOptions {
  kind: "adapters";
}
export interface SavedWorkspaceProfile {
  id: string;
  revision: string;
  profile: AdapterProfile;
}
export interface WorkspaceProfileStore {
  list(): Promise<SavedWorkspaceProfile[]>;
  save(
    options: AdapterConnectionOptions,
    previous?: Pick<SavedWorkspaceProfile, "id" | "revision">,
  ): Promise<SavedWorkspaceProfile>;
  remove(id: string, revision: string): Promise<void>;
}
/** Reopening uses only current public fields; a field reclassified as a password is never prefilled. */
export function restoredConfiguration(
  source: AdapterSource,
  adapter?: AdapterInfo,
): Configuration {
  if (!adapter) return {};
  return Object.fromEntries(
    adapter.configuration
      .filter((field) => field.kind !== "password")
      .flatMap((field) => {
        const value = source.configuration[field.id] ?? field.default;
        const valid =
          field.kind === "text"
            ? typeof value === "string"
            : field.kind === "number"
              ? typeof value === "number"
              : typeof value === "boolean";
        return valid ? [[field.id, value]] : [];
      }),
  ) as Configuration;
}
export interface AdapterServices {
  available?(): Promise<AdapterInfo[]>;
  profiles?: WorkspaceProfileStore;
  replaceSource?(
    sessionId: number,
    expected: ConnectionIdentity,
    options: AdapterConnectionOptions,
    signal?: AbortSignal,
    reviewHostKey?: HostKeyReviewer,
  ): Promise<SourceReplacement>;
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
    reviewHostKey?: HostKeyReviewer,
  ): Promise<Session>;
}
function connectionReview(
  options: AdapterConnectionOptions,
  requestId: number,
  cancel: () => void,
  signal?: AbortSignal,
  review?: HostKeyReviewer,
) {
  const channel = new Channel<HostKeyChallenge>();
  let finished = false,
    failure: unknown;
  channel.onmessage = (challenge) => {
    void (async () => {
      if (finished || signal?.aborted) return;
      if (
        !options.sources.some(
          (source) =>
            source.id === "builtin:ssh" &&
            String(source.configuration.host).toLowerCase() ===
              challenge.host.toLowerCase() &&
            (source.configuration.port ?? 22) === challenge.port,
        )
      )
        throw new Error(
          "Host-key review does not match a selected SSH connection.",
        );
      const approve = (await review?.(challenge)) ?? false;
      if (finished || signal?.aborted) return;
      await invoke("decide_host_key", {
        requestId,
        token: challenge.token,
        approve,
      });
    })().catch((error) => {
      failure = error;
      cancel();
    });
  };
  return {
    channel,
    finish: () => {
      finished = true;
    },
    error: () => failure,
  };
}
export interface SourceReplacement extends WorkspaceStatus {
  sourceRevision: number;
  connections: readonly ConnectionIdentity[];
  cleanupWarning?: string | null;
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
  available: () => invoke("available_connections"),
  profiles: {
    list: () => invoke("list_workspace_profiles"),
    save: (options, previous) =>
      invoke("save_workspace_profile", {
        options,
        id: previous?.id ?? null,
        revision: previous?.revision ?? null,
      }),
    remove: (id, revision) =>
      invoke("remove_workspace_profile", { id, revision }),
  },
  async replaceSource(sessionId, expected, options, signal, reviewHostKey) {
    if (signal?.aborted) throw new Error("Connection canceled");
    const requestId = await invoke<number>("begin_connect");
    const cancel = () => {
      void invoke("cancel_connect", { requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const review = connectionReview(
      options,
      requestId,
      cancel,
      signal,
      reviewHostKey,
    );
    try {
      if (signal?.aborted) throw new Error("Connection canceled");
      // A successful result is already committed. Even late cancellation must
      // deliver it; disconnecting would destroy unrelated workspace services.
      return await invoke<SourceReplacement>("replace_adapter_source", {
        sessionId,
        expected,
        options,
        requestId,
        onHostKey: review.channel,
      });
    } catch (error) {
      throw review.error() ?? error;
    } finally {
      review.finish();
      signal?.removeEventListener("abort", cancel);
      cancel();
    }
  },
  list: () => invoke("list_adapters"),
  review: (requestId) => invoke("review_adapter", { requestId }),
  cancelReview: (requestId) => invoke("cancel_adapter_review", { requestId }),
  install: (requestId) => invoke("install_adapter", { requestId }),
  setEnabled: (id, revision, enabled) =>
    invoke("set_adapter_enabled", { id, revision, enabled }),
  remove: (id, revision) => invoke("remove_adapter", { id, revision }),
  async connect(options, signal, reviewHostKey) {
    if (signal?.aborted) throw new Error("Connection canceled");
    const requestId = await invoke<number>("begin_connect");
    const cancel = () => {
      void invoke("cancel_connect", { requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const review = connectionReview(
      options,
      requestId,
      cancel,
      signal,
      reviewHostKey,
    );
    try {
      if (signal?.aborted) throw new Error("Connection canceled");
      const result = await invoke<Session>("connect_adapters", {
        options,
        requestId,
        onHostKey: review.channel,
      });
      if (signal?.aborted) {
        await invoke("disconnect", { sessionId: result.id });
        throw new Error("Connection canceled");
      }
      return result;
    } catch (error) {
      throw review.error() ?? error;
    } finally {
      review.finish();
      signal?.removeEventListener("abort", cancel);
      cancel();
    }
  },
};
export const defaultAdapterServices = isTauri()
  ? nativeAdapterServices
  : undefined;
