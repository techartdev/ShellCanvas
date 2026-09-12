// SPDX-License-Identifier: MPL-2.0
import type { SessionServices, TextDocument } from "./sdk";

export type SaveDestination = Readonly<
  | { kind: "create"; parent: string; name: string }
  | {
      kind: "replace";
      path: string;
      name: string;
      revision: string;
      saveRequiresConfirmation?: boolean;
    }
>;

/** Discover locations through the provider, never by joining path strings. */
export async function prepareSaveAs(
  services: SessionServices,
  parent: string,
  name: string,
  canReplace: boolean,
): Promise<SaveDestination> {
  if (!parent.trim() || !name.trim() || /[\x00-\x1f\x7f]/.test(name))
    throw new Error(
      "Choose an existing folder and a name without control characters.",
    );
  const directory = await services.list(parent);
  const matches = directory.entries.filter((entry) => entry.name === name);
  if (matches.length > 1)
    throw new Error("The destination name is ambiguous. Choose another name.");
  const entry = matches[0];
  if (!entry)
    return Object.freeze({ kind: "create", parent: directory.path, name });
  if (entry.kind !== "file")
    throw new Error(
      "A folder or link already uses this name. Choose another name.",
    );
  if (!canReplace)
    throw new Error(
      "Replacing files is unavailable on this device. Choose a new name.",
    );
  const target = await services.readText(entry.path);
  if (!target.writable)
    throw new Error("This file cannot be replaced. Choose a new name.");
  return Object.freeze({
    kind: "replace",
    path: target.path,
    name: target.name,
    revision: target.revision,
    ...(target.saveRequiresConfirmation
      ? { saveRequiresConfirmation: true }
      : {}),
  });
}

/** A replacement must be explicitly confirmed by the UI before this call. */
export function commitSaveAs(
  services: SessionServices,
  target: SaveDestination,
  text: string,
  allowNonAtomic = false,
): Promise<TextDocument> {
  return target.kind === "create"
    ? services.createText(target.parent, target.name, text)
    : target.saveRequiresConfirmation
      ? allowNonAtomic
        ? services.saveText(target.path, text, target.revision, true)
        : Promise.reject(
            new Error("Non-atomic replacement requires explicit confirmation."),
          )
      : services.saveText(target.path, text, target.revision);
}
