// SPDX-License-Identifier: MPL-2.0
import manifest from "../../shellcanvas.catalog.json";
import type { InstalledApp } from "./catalog";
import { matchesSearch } from "./app-listing";
import { parseRepositoryLocation, type RepositoryLocation } from "./repository";

const CURATOR = Object.freeze({
  name: "ShellCanvas",
  owner: "techartdev",
  repository: "ShellCanvas",
});
const APP_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const CATALOG_KEYS = [
  "$schema",
  "format",
  "kind",
  "id",
  "title",
  "curator",
  "apps",
] as const;
const CURATOR_KEYS = ["name", "owner", "repository"] as const;
const APP_KEYS = ["id", "title", "description", "source"] as const;
const SOURCE_KEYS = ["owner", "repository", "ref"] as const;

export interface FirstPartyApp {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly source: RepositoryLocation;
}

export interface FirstPartyCatalog {
  readonly format: 1;
  readonly kind: "app-catalog";
  readonly id: "dev.shellcanvas.first-party";
  readonly title: string;
  readonly curator: typeof CURATOR;
  readonly apps: readonly FirstPartyApp[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, limit: number) {
  return typeof value === "string" && !!value.trim() && value.length <= limit;
}

/** Validates the bundled, release-reviewed catalog before it reaches the UI. */
export function parseFirstPartyCatalog(value: unknown): FirstPartyCatalog {
  const item = record(value);
  const curator = record(item?.curator);
  if (
    !item ||
    !onlyKeys(item, CATALOG_KEYS) ||
    item.format !== 1 ||
    item.kind !== "app-catalog" ||
    item.id !== "dev.shellcanvas.first-party" ||
    (item.$schema !== undefined &&
      item.$schema !== "docs/schemas/app-catalog.schema.json") ||
    !text(item.title, 100) ||
    !curator ||
    !onlyKeys(curator, CURATOR_KEYS) ||
    curator.name !== CURATOR.name ||
    curator.owner !== CURATOR.owner ||
    curator.repository !== CURATOR.repository ||
    !Array.isArray(item.apps) ||
    item.apps.length > 100
  )
    throw new Error("Invalid ShellCanvas first-party app catalog.");

  const ids = new Set<string>();
  const apps = item.apps.map((value) => {
    const app = record(value);
    const source = record(app?.source);
    if (
      !app ||
      !onlyKeys(app, APP_KEYS) ||
      typeof app.id !== "string" ||
      !APP_ID.test(app.id) ||
      ids.has(app.id) ||
      !text(app.title, 100) ||
      !text(app.description, 1000) ||
      !source ||
      !onlyKeys(source, SOURCE_KEYS) ||
      source.owner !== CURATOR.owner ||
      typeof source.repository !== "string" ||
      typeof source.ref !== "string"
    )
      throw new Error("Invalid ShellCanvas first-party app catalog.");
    let location: RepositoryLocation;
    try {
      location = parseRepositoryLocation(
        `${source.owner}/${source.repository}`,
        source.ref,
      );
    } catch {
      throw new Error("Invalid ShellCanvas first-party app catalog.");
    }
    ids.add(app.id);
    return Object.freeze({
      id: app.id,
      title: app.title as string,
      description: app.description as string,
      source: Object.freeze(location),
    });
  });
  return Object.freeze({
    format: 1,
    kind: "app-catalog",
    id: "dev.shellcanvas.first-party",
    title: item.title as string,
    curator: CURATOR,
    apps: Object.freeze(apps),
  });
}

export const firstPartyCatalog = parseFirstPartyCatalog(manifest);

export function firstPartyRecommendations(
  installed: readonly Pick<InstalledApp, "package">[],
  query = "",
  catalog: FirstPartyCatalog = firstPartyCatalog,
) {
  const installedIds = new Set(installed.map((entry) => entry.package.id));
  return catalog.apps.filter(
    (app) =>
      !installedIds.has(app.id) &&
      matchesSearch(query, [
        app.title,
        app.description,
        app.id,
        `${app.source.owner}/${app.source.repository}`,
      ]),
  );
}
