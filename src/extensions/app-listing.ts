// SPDX-License-Identifier: MPL-2.0
import type { InstalledApp } from "./catalog";

/** The short line shown under an installed app's title. */
export function appSummary(
  entry: Pick<InstalledApp, "package" | "listing" | "source">,
) {
  return (
    entry.package.description ??
    entry.listing ??
    (entry.source
      ? `From ${entry.source.owner}/${entry.source.repository}`
      : "Installed from an app package")
  );
}

/** Every search term must appear in one of the fields, ignoring case. */
export function matchesSearch(
  query: string,
  fields: readonly (string | undefined)[],
) {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = fields
    .filter((field): field is string => !!field)
    .join("\n")
    .toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

/** Installed apps in a stable, human order. */
export function byTitle<T extends Pick<InstalledApp, "package">>(
  apps: readonly T[],
): T[] {
  return [...apps].sort(
    (a, b) =>
      a.package.title.localeCompare(b.package.title, undefined, {
        sensitivity: "base",
      }) || a.package.id.localeCompare(b.package.id),
  );
}
