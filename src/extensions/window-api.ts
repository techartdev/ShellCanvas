// SPDX-License-Identifier: MPL-2.0
import { RpcError, type RpcMethod } from "./rpc";
import type { AppDocumentState } from "../../packages/app-sdk/src/window-api";
export type { AppDocumentState } from "../../packages/app-sdk/src/window-api";
/** Intrinsic authority: an app may describe only its own window's document state. */
export function documentStateMethod(
  update: (state: AppDocumentState) => void,
): RpcMethod {
  return {
    grants: [],
    invoke(value) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.dirty !== "boolean" ||
        typeof value.busy !== "boolean" ||
        (value.title !== undefined &&
          (typeof value.title !== "string" ||
            !value.title.trim() ||
            value.title.length > 120)) ||
        Object.keys(value).some(
          (key) => !["dirty", "busy", "title"].includes(key),
        )
      )
        throw new RpcError(
          "invalid",
          "Provide dirty, busy and an optional window title.",
        );
      update({
        dirty: value.dirty,
        busy: value.busy,
        ...(typeof value.title === "string" ? { title: value.title } : {}),
      });
      return null;
    },
  };
}
