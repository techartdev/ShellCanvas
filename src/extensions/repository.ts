// SPDX-License-Identifier: MPL-2.0
import { invoke, isTauri } from "@tauri-apps/api/core";
import { parseAppRepository } from "../../packages/app-sdk/src/repository";
import { parseAppPackage } from "./package";

export interface RepositoryLocation {
  owner: string;
  repository: string;
  ref: string;
}
export function parseRepositoryLocation(
  input: string,
  ref = "main",
): RepositoryLocation {
  const value = input.trim().replace(/\/$/, "");
  const match =
    /^(?:https:\/\/github\.com\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})$/.exec(
      value,
    );
  if (
    !match ||
    !ref ||
    ref.length > 200 ||
    !ref
      .split("/")
      .every(
        (part) =>
          /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) &&
          part !== "." &&
          part !== "..",
      )
  )
    throw new Error(
      "Enter a GitHub owner/repository and a valid branch, tag or commit.",
    );
  return { owner: match[1], repository: match[2].replace(/\.git$/, ""), ref };
}

export type RepositoryReader = (
  location: RepositoryLocation,
  path: string,
  limit: number,
  signal: AbortSignal,
) => Promise<string>;
function checkAbort(signal: AbortSignal) {
  // Catalina's AbortSignal predates throwIfAborted().
  if (signal.aborted)
    throw new DOMException("Repository read cancelled.", "AbortError");
}
export const readRepositoryFile: RepositoryReader = async (
  location,
  path,
  limit,
  signal,
) => {
  checkAbort(signal);
  if (!isTauri())
    throw new Error("Repository installation is available in the desktop app.");
  const id = await invoke<string>("prepare_repository_read");
  const cancel = () => {
    void invoke("cancel_repository_read", { id }).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    checkAbort(signal);
    const text = await invoke<string>("read_repository_file", {
      id,
      owner: location.owner,
      repository: location.repository,
      reference: location.ref,
      path,
      limit,
    });
    checkAbort(signal);
    return text;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
};

export async function inspectRepository(
  input: string,
  ref: string,
  signal: AbortSignal,
  read: RepositoryReader = readRepositoryFile,
) {
  const location = parseRepositoryLocation(input, ref);
  const manifest = parseAppRepository(
    await read(location, "shellcanvas.repo.json", 65536, signal),
  );
  checkAbort(signal);
  const raw = await read(
    location,
    manifest.package.path,
    32 * 1024 * 1024,
    signal,
  );
  checkAbort(signal);
  const bytes = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== manifest.package.sha256)
    throw new Error(
      "Package integrity check failed. The repository may have changed; review it again.",
    );
  const app = parseAppPackage(raw);
  if (
    app.id !== manifest.id ||
    app.version !== manifest.version ||
    app.title !== manifest.title
  )
    throw new Error(
      "The package identity does not match the repository manifest.",
    );
  checkAbort(signal);
  return {
    raw,
    manifest,
    source: Object.freeze({ ...location, sha256: digest }),
  };
}
