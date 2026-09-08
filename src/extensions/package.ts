// SPDX-License-Identifier: MPL-2.0
import { RpcError } from "./rpc";
import type { AppPackage } from "../../packages/app-sdk/src/package";
export { parseAppPackage } from "../../packages/app-sdk/src/package";
export type { AppPackage } from "../../packages/app-sdk/src/package";
/** Construct the document ourselves: packages supply JS/CSS, not privileged frame markup. */
export function appDocument(app: AppPackage, nonce: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(nonce))
    throw new RpcError("invalid", "Invalid document nonce.");
  const script = app.script.replace(/<\/script/gi, "<\\/script");
  const style = app.style.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="shellcanvas-instance" content="${nonce}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;min-height:100%;background:#182731;color:#dce7ec;font:14px system-ui;color-scheme:dark}*{box-sizing:border-box}${style}</style></head><body><div id="root"></div><script nonce="${nonce}">${script}</script></body></html>`;
}
