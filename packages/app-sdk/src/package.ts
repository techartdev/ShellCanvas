// SPDX-License-Identifier: MPL-2.0
import { RpcError } from "./rpc.js";
/** Experimental self-contained UI package. Native adapters use a separate executable kind. */
export interface AppPackage {
  readonly format: 1;
  readonly kind: "app";
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly permissions: readonly string[];
  readonly script: string;
  readonly style: string;
}
export type AppManifest = Omit<AppPackage, "script" | "style">;
/** Editor schema metadata is accepted in source manifests, never in executable packages. */
export function parseAppManifest(raw: string): AppManifest {
  if (raw.length > 16 * 1024 * 1024)
    throw new RpcError("invalid", "App manifest is too large.");
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    "script" in value ||
    "style" in value ||
    (value.$schema !== undefined && typeof value.$schema !== "string")
  )
    throw new RpcError("invalid", "Invalid app source manifest.");
  const { $schema: _schema, ...manifest } = value;
  const parsed = parseAppPackage(
    JSON.stringify({ ...manifest, script: "void 0;", style: "" }),
  );
  const { script: _script, style: _style, ...result } = parsed;
  return Object.freeze(result);
}
export function parseAppPackage(raw: string): AppPackage {
  // Packaging limit is independent of remote file/tree sizes. No external assets are loaded.
  if (raw.length > 16 * 1024 * 1024)
    throw new RpcError("invalid", "App package is too large.");
  const item = JSON.parse(raw);
  if (
    !item ||
    item.format !== 1 ||
    item.kind !== "app" ||
    typeof item.id !== "string" ||
    !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(item.id) ||
    typeof item.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(item.version) ||
    typeof item.title !== "string" ||
    !item.title.trim() ||
    item.title.length > 100 ||
    typeof item.script !== "string" ||
    !item.script.trim() ||
    typeof item.style !== "string" ||
    !Array.isArray(item.permissions) ||
    item.permissions.some(
      (permission: unknown) =>
        typeof permission !== "string" ||
        !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(permission),
    ) ||
    new Set(item.permissions).size !== item.permissions.length ||
    Object.keys(item).some(
      (key) =>
        ![
          "format",
          "kind",
          "id",
          "version",
          "title",
          "permissions",
          "script",
          "style",
        ].includes(key),
    )
  ) {
    throw new RpcError("invalid", "Invalid or unsupported app package.");
  }
  return Object.freeze({
    ...item,
    permissions: Object.freeze([...item.permissions]),
  });
}
