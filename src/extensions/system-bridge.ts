// SPDX-License-Identifier: MPL-2.0
import { SystemError, type SystemAPI } from "../system-api";
import { RpcError, type Json, type RpcMethod } from "./rpc";

function options(
  value: Json,
  fields: Record<string, "string" | "boolean" | "strings" | "buttons">,
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RpcError("invalid", "Options must be an object.");
  for (const [key, item] of Object.entries(value)) {
    const field = fields[key];
    let valid = false;
    if (field === "string" || field === "boolean")
      valid = typeof item === field;
    else if (field === "strings")
      valid =
        Array.isArray(item) && item.every((part) => typeof part === "string");
    else if (field === "buttons")
      valid =
        Array.isArray(item) &&
        item.every((part) => {
          if (!part || typeof part !== "object" || Array.isArray(part))
            return false;
          return (
            typeof part.id === "string" &&
            typeof part.label === "string" &&
            (part.destructive === undefined ||
              typeof part.destructive === "boolean") &&
            Object.keys(part).every((name) =>
              ["id", "label", "destructive"].includes(name),
            )
          );
        });
    if (!valid) throw new RpcError("invalid", `Invalid option: ${key}`);
  }
  return value;
}
const pickerFields = { title: "string", directory: "string" } as const;
/** The host supplies one window-owned SystemAPI. No session ID is accepted from the app. */
export function systemMethods(
  system: SystemAPI,
  grants: readonly string[] = [],
): ReadonlyMap<string, RpcMethod> {
  const canReplace = grants.includes("files.edit");
  function method(
    grants: string[],
    action: (params: Json, signal: AbortSignal) => Promise<unknown>,
  ): RpcMethod {
    return {
      grants,
      async invoke(params, signal) {
        try {
          const result = await action(params, signal);
          // SDK records may contain undefined optional fields. The wire contract is JSON only.
          return JSON.parse(JSON.stringify(result)) as Json;
        } catch (error) {
          if (error instanceof SystemError)
            throw new RpcError(error.code, error.message);
          throw error;
        }
      },
    };
  }
  return new Map<string, RpcMethod>([
    [
      "system.dialogs.messageBox",
      method(["system.dialogs"], async (value, signal) => {
        const checked = options(value, {
          title: "string",
          message: "string",
          kind: "string",
          buttons: "buttons",
          defaultId: "string",
          cancelId: "string",
        });
        if (
          typeof checked.title !== "string" ||
          typeof checked.message !== "string"
        )
          throw new RpcError("invalid", "Title and message are required.");
        return system.dialogs.messageBox(
          checked as unknown as Parameters<
            SystemAPI["dialogs"]["messageBox"]
          >[0],
          { signal },
        );
      }),
    ],
    [
      "system.dialogs.openFile",
      method(["system.dialogs", "files.read"], async (value, signal) => {
        const checked = options(value, {
          ...pickerFields,
          kind: "string",
          multiple: "boolean",
          extensions: "strings",
        });
        return system.dialogs.openFile(
          checked as Parameters<SystemAPI["dialogs"]["openFile"]>[0],
          { signal },
        );
      }),
    ],
    [
      "system.dialogs.saveFile",
      method(["system.dialogs", "files.read"], async (value, signal) => {
        const checked = options(value, { ...pickerFields, name: "string" });
        return system.dialogs.saveFile(
          checked as Parameters<SystemAPI["dialogs"]["saveFile"]>[0],
          { signal },
        );
      }),
    ],
    [
      "system.files.saveTextAs",
      method(
        ["system.dialogs", "files.read", "files.create"],
        async (value, signal) => {
          const checked = options(value, {
            ...pickerFields,
            name: "string",
            text: "string",
            allowReplace: "boolean",
          });
          if (typeof checked.text !== "string")
            throw new RpcError("invalid", "Text is required.");
          return system.files.saveTextAs(
            {
              ...checked,
              allowReplace: canReplace && checked.allowReplace !== false,
            } as unknown as Parameters<SystemAPI["files"]["saveTextAs"]>[0],
            { signal },
          );
        },
      ),
    ],
  ]);
}
