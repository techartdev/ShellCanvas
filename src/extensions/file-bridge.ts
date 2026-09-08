// SPDX-License-Identifier: MPL-2.0
import type { SessionServices } from "../sdk";
import { RpcError, type Json, type RpcMethod } from "./rpc";

export interface AppFileSource {
  binding: string;
  services: Pick<
    SessionServices,
    | "readText"
    | "saveText"
    | "createText"
    | "list"
    | "makeDirectory"
    | "renameEntry"
    | "moveEntry"
    | "removeEntry"
  >;
}
/** Supplied by the owning window, never by extension parameters. */
export type AppFileSourceGetter = () => AppFileSource | undefined;

export function fileMethods(
  source: AppFileSourceGetter,
): ReadonlyMap<string, RpcMethod> {
  function method(
    grant: string,
    fields: readonly string[],
    action: (
      services: AppFileSource["services"],
      params: Record<string, string>,
    ) => Promise<unknown>,
  ): RpcMethod {
    return {
      grants: [grant],
      async invoke(value: Json, signal: AbortSignal) {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length !== fields.length ||
          fields.some((key) => typeof value[key] !== "string")
        )
          throw new RpcError(
            "invalid",
            "Supply the documented file parameters only.",
          );
        const params = value as Record<string, string>;
        const captured = source();
        if (!captured)
          throw new RpcError(
            "unavailable",
            "No file source in this workspace.",
          );
        if (params.binding !== captured.binding)
          throw new RpcError(
            "closed",
            "This location belongs to a previous workspace binding. Choose a destination on the current connection.",
          );
        if (signal.aborted)
          throw new RpcError(
            "aborted",
            "File operation canceled before dispatch.",
          );
        let result: unknown;
        try {
          result = await action(captured.services, params);
        } catch (error) {
          if (error instanceof RpcError) throw error;
          const message =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "File service operation failed.";
          throw new RpcError("failed", message.slice(0, 4096));
        }
        // Native file operations cannot undo a dispatched write. Never retry or return
        // an old document as if it belonged to the replacement connection.
        const current = source();
        if (
          signal.aborted ||
          current?.binding !== captured.binding ||
          current.services !== captured.services
        )
          throw new RpcError(
            signal.aborted ? "aborted" : "closed",
            "File operation ended after cancellation or a connection change. A dispatched write may have completed; inspect before retrying.",
          );
        if (result === undefined || result === null) return null;
        return {
          ...JSON.parse(JSON.stringify(result)),
          binding: captured.binding,
        } as Json;
      },
    };
  }
  return new Map([
    [
      "system.files.makeDirectory",
      method(
        "files.manage",
        ["binding", "parent", "name"],
        async (services, p) => ({
          path: await services.makeDirectory(p.parent, p.name),
        }),
      ),
    ],
    [
      "system.files.renameEntry",
      method(
        "files.manage",
        ["binding", "path", "revision", "name"],
        async (services, p) => ({
          path: await services.renameEntry(p.path, p.name, p.revision),
        }),
      ),
    ],
    [
      "system.files.moveEntry",
      method(
        "files.move",
        ["binding", "path", "revision", "parent", "parentBinding"],
        async (services, p) => {
          if (p.binding !== p.parentBinding)
            throw new RpcError(
              "invalid",
              "Move source and destination must belong to the same workspace binding.",
            );
          return {
            path: await services.moveEntry(p.path, p.parent, p.revision),
          };
        },
      ),
    ],
    [
      "system.files.removeEntry",
      method("files.manage", ["binding", "path", "revision"], (services, p) =>
        services.removeEntry(p.path, p.revision),
      ),
    ],
    [
      "system.files.readText",
      method("files.read", ["binding", "path"], (services, p) =>
        services.readText(p.path),
      ),
    ],
    [
      "system.files.saveText",
      method(
        "files.edit",
        ["binding", "path", "revision", "text"],
        (services, p) => services.saveText(p.path, p.text, p.revision),
      ),
    ],
    [
      "system.files.createText",
      method(
        "files.create",
        ["binding", "parent", "name", "text"],
        (services, p) => services.createText(p.parent, p.name, p.text),
      ),
    ],
  ]);
}
