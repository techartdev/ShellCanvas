// SPDX-License-Identifier: MPL-2.0
import { RpcError } from "./rpc.js";

export interface RepositorySource {
  readonly owner: string;
  readonly repository: string;
  readonly ref: string;
  readonly sha256: string;
}
export function parseRepositorySource(value: unknown): RepositorySource {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RpcError("invalid", "Invalid repository source.");
  const item = value as Record<string, unknown>;
  if (
    typeof item.owner !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(item.owner) ||
    typeof item.repository !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(item.repository) ||
    typeof item.ref !== "string" ||
    item.ref.length > 200 ||
    !validRepositoryPath(item.ref) ||
    typeof item.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.sha256)
  )
    throw new RpcError("invalid", "Invalid repository source.");
  return Object.freeze({
    owner: item.owner,
    repository: item.repository,
    ref: item.ref,
    sha256: item.sha256,
  });
}

/** Root shellcanvas.repo.json; executable app permissions remain in the package. */
export interface AppRepositoryManifest {
  readonly format: 1;
  readonly kind: "app-repository";
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly package: { readonly path: string; readonly sha256: string };
}

export function validRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    path
      .split("/")
      .every(
        (part) =>
          /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) &&
          part !== "." &&
          part !== "..",
      )
  );
}

export function parseAppRepository(raw: string): AppRepositoryManifest {
  if (new TextEncoder().encode(raw).length > 65536)
    throw new RpcError("invalid", "Repository manifest is too large.");
  let item: any;
  try {
    item = JSON.parse(raw);
  } catch {
    throw new RpcError("invalid", "Repository manifest is not valid JSON.");
  }
  if (
    !item ||
    typeof item !== "object" ||
    Array.isArray(item) ||
    item.format !== 1 ||
    item.kind !== "app-repository" ||
    typeof item.id !== "string" ||
    !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(item.id) ||
    typeof item.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(item.version) ||
    typeof item.title !== "string" ||
    !item.title.trim() ||
    item.title.length > 100 ||
    typeof item.description !== "string" ||
    item.description.length > 1000 ||
    !item.package ||
    typeof item.package !== "object" ||
    Array.isArray(item.package) ||
    typeof item.package.path !== "string" ||
    !validRepositoryPath(item.package.path) ||
    typeof item.package.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.package.sha256) ||
    Object.keys(item).some(
      (key) =>
        ![
          "format",
          "kind",
          "id",
          "version",
          "title",
          "description",
          "package",
        ].includes(key),
    ) ||
    Object.keys(item.package).some((key) => !["path", "sha256"].includes(key))
  )
    throw new RpcError(
      "invalid",
      "Invalid or unsupported ShellCanvas repository manifest.",
    );
  return Object.freeze({
    ...item,
    package: Object.freeze({ ...item.package }),
  });
}
