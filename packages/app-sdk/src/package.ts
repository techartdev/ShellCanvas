// SPDX-License-Identifier: MPL-2.0
import { RpcError } from "./rpc.js";
import { clientPlatforms, type ClientPlatform } from "./client-platform.js";
/** Experimental self-contained UI package. Native adapters use a separate executable kind. */
export interface AppPackage {
  readonly format: 1;
  readonly kind: "app";
  readonly id: string;
  readonly version: string;
  readonly title: string;
  /** One-line summary shown with the title in app listings. */
  readonly description?: string;
  /** Embedded image data URI. The desktop never fetches icons from a URL. */
  readonly icon?: string;
  readonly permissions: readonly string[];
  /** Allowed ShellCanvas client targets. Omit for an unrestricted portable app. */
  readonly clientPlatforms?: readonly ClientPlatform[];
  readonly script: string;
  readonly style: string;
}
/** Source manifests name an icon file beside `shellcanvas.json`; packaging embeds it. */
export type AppManifest = Omit<AppPackage, "script" | "style" | "icon"> & {
  readonly icon?: string;
};
/** UTF-16 code units, like the title limit. */
export const APP_DESCRIPTION_MAX_LENGTH = 160;
/** Decoded icon bytes. Icons are listing metadata, not app resources. */
export const APP_ICON_MAX_BYTES = 256 * 1024;
export const appIconTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
} as const;
const iconDataUri =
  /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/;
/** A lowercase png, jpg, jpeg, webp or svg path inside the app directory. */
export function validAppIconPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 240 &&
    /\.(?:png|jpe?g|webp|svg)$/.test(path) &&
    path.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))
  );
}
/** Checks the declared type against the image signature and the size bound. */
export function validAppIcon(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = iconDataUri.exec(value);
  if (!match || match[2].length % 4) return false;
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  if ((match[2].length / 4) * 3 - padding > APP_ICON_MAX_BYTES) return false;
  let head: string;
  try {
    head = atob(match[1] === "image/svg+xml" ? match[2] : match[2].slice(0, 16));
  } catch {
    return false;
  }
  switch (match[1]) {
    case "image/png":
      return head.startsWith("\x89PNG\r\n\x1a\n");
    case "image/jpeg":
      return head.startsWith("\xff\xd8\xff");
    case "image/webp":
      return head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
    default:
      return /<svg[\s>]/i.test(head);
  }
}
function validDescription(value: unknown) {
  return (
    typeof value === "string" &&
    /\S/.test(value) &&
    value.length <= APP_DESCRIPTION_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
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
    (value.$schema !== undefined && typeof value.$schema !== "string") ||
    (value.icon !== undefined && !validAppIconPath(value.icon))
  )
    throw new RpcError("invalid", "Invalid app source manifest.");
  const { $schema: _schema, icon, ...manifest } = value;
  const parsed = parseAppPackage(
    JSON.stringify({ ...manifest, script: "void 0;", style: "" }),
  );
  const { script: _script, style: _style, ...result } = parsed;
  return Object.freeze(icon === undefined ? result : { ...result, icon });
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
    (item.description !== undefined && !validDescription(item.description)) ||
    (item.icon !== undefined && !validAppIcon(item.icon)) ||
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
    (item.clientPlatforms !== undefined &&
      (!Array.isArray(item.clientPlatforms) ||
        !item.clientPlatforms.length ||
        item.clientPlatforms.some(
          (platform: unknown) =>
            !clientPlatforms.some((known) => known === platform),
        ) ||
        new Set(item.clientPlatforms).size !== item.clientPlatforms.length)) ||
    Object.keys(item).some(
      (key) =>
        ![
          "format",
          "kind",
          "id",
          "version",
          "title",
          "description",
          "icon",
          "permissions",
          "clientPlatforms",
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
    ...(item.clientPlatforms === undefined
      ? {}
      : { clientPlatforms: Object.freeze([...item.clientPlatforms]) }),
  });
}
