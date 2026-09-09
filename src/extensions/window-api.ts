// SPDX-License-Identifier: MPL-2.0
import { RpcError, type Json, type RpcMethod } from "./rpc";
import { emptyOptions } from "./environment";
import type {
  AppDocumentState,
  AppWindowState,
} from "../../packages/app-sdk/src/window-api";
export type { AppDocumentState } from "../../packages/app-sdk/src/window-api";
export interface WindowControls {
  getState(): AppWindowState;
  focus(): void;
  minimize(): void;
  maximize(): void;
  restore(): void;
  requestClose(): void;
}
/** No caller-supplied identity or permission can expand this window-owned authority. */
export function windowMethods(
  controls: () => WindowControls | undefined,
): Map<string, RpcMethod> {
  return new Map(
    (
      [
        "getState",
        "focus",
        "minimize",
        "maximize",
        "restore",
        "requestClose",
      ] as const
    ).map((action) => [
      `system.window.${action}`,
      {
        grants: [],
        available: () => !!controls(),
        invoke(params: Json, signal: AbortSignal) {
          emptyOptions(params);
          if (signal.aborted)
            throw new RpcError("aborted", "Window request canceled.");
          const owner = controls();
          if (!owner)
            throw new RpcError(
              "unavailable",
              "Window controls are unavailable.",
            );
          return (owner[action]() ?? null) as Json;
        },
      },
    ]),
  );
}
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
