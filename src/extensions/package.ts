// SPDX-License-Identifier: MPL-2.0
import { RpcError } from "./rpc";
/** Experimental self-contained UI package. Native adapters will use a separate executable kind. */
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

/** Construct the document ourselves: packages supply JS/CSS, not privileged frame markup. */
export function appDocument(app: AppPackage, nonce: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(nonce))
    throw new RpcError("invalid", "Invalid document nonce.");
  const script = app.script.replace(/<\/script/gi, "<\\/script");
  const style = app.style.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;min-height:100%;background:#182731;color:#dce7ec;font:14px system-ui}*{box-sizing:border-box}${style}</style></head><body><div id="root"></div><script nonce="${nonce}">${script}</script></body></html>`;
}
