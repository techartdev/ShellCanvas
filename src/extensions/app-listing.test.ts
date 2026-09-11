// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { appSummary, byTitle, matchesSearch } from "./app-listing";
import type { InstalledApp } from "./catalog";

const entry = (
  title: string,
  change: Partial<InstalledApp["package"]> = {},
  extra: Partial<Pick<InstalledApp, "listing" | "source">> = {},
) =>
  ({
    package: {
      format: 1,
      kind: "app",
      id: `org.example.${title.toLowerCase().replace(/\W+/g, "-")}`,
      version: "1.0.0",
      title,
      permissions: [],
      script: "void 0",
      style: "",
      ...change,
    },
    ...extra,
  }) as Pick<InstalledApp, "package" | "listing" | "source">;
const source = {
  owner: "example",
  repository: "notes",
  ref: "main",
  sha256: "a".repeat(64),
};

it("prefers the package description, then the repository listing, then provenance", () => {
  expect(
    appSummary(
      entry(
        "Notes",
        { description: "Packaged" },
        { listing: "Listed", source },
      ),
    ),
  ).toBe("Packaged");
  expect(appSummary(entry("Notes", {}, { listing: "Listed", source }))).toBe(
    "Listed",
  );
  expect(appSummary(entry("Notes", {}, { source }))).toBe("From example/notes");
  expect(appSummary(entry("Notes"))).toBe("Installed from an app package");
});

it("matches every search term across fields, ignoring case and missing fields", () => {
  const fields = ["Field Notes", undefined, "Draft notes on remote hosts"];
  expect(matchesSearch("", fields)).toBe(true);
  expect(matchesSearch("   ", fields)).toBe(true);
  expect(matchesSearch("NOTES", fields)).toBe(true);
  expect(matchesSearch("field remote", fields)).toBe(true);
  expect(matchesSearch("field terminal", fields)).toBe(false);
});

it("orders installed apps by title without mutating the catalog order", () => {
  const apps = [entry("zeta"), entry("Alpha"), entry("beta")];
  expect(byTitle(apps).map((item) => item.package.title)).toEqual([
    "Alpha",
    "beta",
    "zeta",
  ]);
  expect(apps[0].package.title).toBe("zeta");
});
