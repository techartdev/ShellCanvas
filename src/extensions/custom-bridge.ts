// SPDX-License-Identifier: MPL-2.0
import type { CustomAccess } from "../custom-services";
import { RpcError, type RpcMethod } from "./rpc";
import type { ServiceMethodInfo } from "./environment-api";
/** The trusted desktop supplies the access object; frames never provide a session or binding. */
export function customMethods(
  access: CustomAccess | undefined,
  grants: readonly string[],
  connected: () => boolean,
) {
  let cached: ServiceMethodInfo[] = [];
  const list = async (signal?: AbortSignal): Promise<ServiceMethodInfo[]> => {
    if (!access) return [];
    if (!connected())
      return cached.map((item) => ({ ...item, available: false }));
    cached = (await access.list(signal)).map((item) => ({
      name: item.name,
      version: item.version,
      permissions: [`services.${item.service}`],
      granted: grants.includes(`services.${item.service}`),
      available: connected() && item.available,
      source: item.binding,
    }));
    return cached;
  };
  const call: RpcMethod = {
    grants: [],
    async invoke(value, signal) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.method !== "string" ||
        Object.keys(value).some((key) => !["method", "params"].includes(key))
      )
        throw new RpcError(
          "invalid",
          "Provide a custom service method and JSON parameters",
        );
      if (!access || !connected())
        throw new RpcError(
          "unavailable",
          "The accepted workspace connection is unavailable",
        );
      const item = (await access.list(signal)).find(
        (item) => item.name === value.method,
      );
      if (!item)
        throw new RpcError(
          "unavailable",
          "This workspace does not expose that service method",
        );
      if (!grants.includes(`services.${item.service}`))
        throw new RpcError(
          "denied",
          `This app needs the services.${item.service} permission`,
        );
      if (signal.aborted)
        throw new RpcError("aborted", "Service call canceled");
      if (!connected() || !item.available)
        throw new RpcError(
          "unavailable",
          "The selected service is unavailable",
        );
      return access.call(item.binding, item.name, value.params ?? null, signal);
    },
  };
  return { list, call };
}
