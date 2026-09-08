// SPDX-License-Identifier: MPL-2.0
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionIdentity } from "./sdk";
import { RpcError, type RpcCode, type Json } from "./extensions/rpc";
export interface CustomMethodInfo {
  name: string;
  service: string;
  version: number;
  binding: string;
  available: boolean;
}
export interface CustomAccess {
  list(signal?: AbortSignal): Promise<readonly CustomMethodInfo[]>;
  call(
    binding: string,
    method: string,
    params: Json,
    signal?: AbortSignal,
  ): Promise<Json>;
}
export interface CustomBackend {
  list(
    sessionId: number,
    signal?: AbortSignal,
  ): Promise<readonly CustomMethodInfo[]>;
  call(
    sessionId: number,
    binding: string,
    method: string,
    params: Json,
    signal?: AbortSignal,
  ): Promise<Json>;
}
function aborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new RpcError("aborted", "Service request canceled");
}
function failure(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  ) {
    const value = error as {
      code: string;
      message: string;
      outcomeUncertain?: boolean;
    };
    const code: RpcCode = [
      "invalid",
      "closed",
      "aborted",
      "denied",
      "unavailable",
      "busy",
    ].includes(value.code)
      ? (value.code as RpcCode)
      : "failed";
    return new RpcError(
      code,
      String(value.message) +
        (value.outcomeUncertain
          ? " The remote outcome may be uncertain; inspect before retrying."
          : ""),
    );
  }
  return new RpcError("failed", "Custom service request failed");
}
export function createNativeCustomServices(pins?: {
  sessionId: number;
  sources: Readonly<Record<string, ConnectionIdentity>>;
}): CustomBackend {
  // Copy at acceptance; callers cannot repin existing handles by mutating metadata.
  const accepted = pins
    ? { sessionId: pins.sessionId, sources: structuredClone(pins.sources) }
    : undefined;
  function check(sessionId: number) {
    if (accepted && accepted.sessionId !== sessionId)
      throw new RpcError(
        "closed",
        "Service binding belongs to another workspace",
      );
  }
  return {
    async list(sessionId, signal) {
      check(sessionId);
      aborted(signal);
      const result = await invoke<CustomMethodInfo[]>("list_custom_services", {
        sessionId,
        ...(accepted ? { sources: accepted.sources } : {}),
      });
      aborted(signal);
      return result;
    },
    async call(sessionId, binding, method, params, signal) {
      check(sessionId);
      aborted(signal);
      const requestId = await invoke<string>("begin_custom_call").catch(
        (error) => {
          throw failure(error);
        },
      );
      const cancel = () => {
        void invoke("cancel_custom_call", { requestId }).catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        aborted(signal);
        const result = await invoke<Json>("call_custom_service", {
          sessionId,
          requestId,
          binding,
          method,
          params,
        });
        if (signal?.aborted)
          throw new RpcError(
            "aborted",
            "Service call canceled; dispatched effects may have occurred.",
          );
        return result;
      } catch (error) {
        throw failure(error);
      } finally {
        signal?.removeEventListener("abort", cancel);
        cancel();
      }
    },
  };
}
export const nativeCustomServices = createNativeCustomServices();
