// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import type { InstalledApp } from "./catalog";
import {
  FIRST_PARTY_CATALOG_LIMIT,
  FIRST_PARTY_CATALOG_LOCATION,
  FIRST_PARTY_CATALOG_PATH,
  FirstPartyCatalogLoader,
  firstPartyCatalog,
  firstPartyRecommendations,
  parseFirstPartyCatalog,
} from "./first-party-catalog";
import { assertRepositoryAppId, type RepositoryReader } from "./repository";

function clone() {
  return JSON.parse(JSON.stringify(firstPartyCatalog));
}

it("loads the bundled, source-bound first-party recommendation", () => {
  expect(firstPartyCatalog.apps).toEqual([
    expect.objectContaining({
      id: "dev.shellcanvas.assistant",
      title: "Canvas Assistant",
      source: {
        owner: "techartdev",
        repository: "ShellCanvas-Assistant",
        ref: "main",
      },
    }),
  ]);
  expect(Object.isFrozen(firstPartyCatalog.apps[0].source)).toBe(true);
});

it("hides installed apps and applies the store search to recommendations", () => {
  expect(firstPartyRecommendations([], "assistant")).toHaveLength(1);
  expect(firstPartyRecommendations([], "ShellCanvas-Assistant")).toHaveLength(
    1,
  );
  expect(firstPartyRecommendations([], "unrelated")).toEqual([]);
  expect(
    firstPartyRecommendations([
      {
        package: { id: "dev.shellcanvas.assistant" },
      } as InstalledApp,
    ]),
  ).toEqual([]);
});

it("rejects catalogs that could self-label an external or ambiguous source", () => {
  for (const change of [
    (value: any) => (value.apps[0].source.owner = "someone-else"),
    (value: any) => (value.apps[0].source.ref = "../unsafe"),
    (value: any) => value.apps.push({ ...value.apps[0] }),
    (value: any) => (value.apps[0].unexpected = true),
    (value: any) => (value.curator.repository = "lookalike"),
  ]) {
    const value = clone();
    change(value);
    expect(() => parseFirstPartyCatalog(value)).toThrow(
      "Invalid ShellCanvas first-party app catalog.",
    );
  }
});

it("requires the fetched repository to retain the catalog-pinned app identity", () => {
  expect(() =>
    assertRepositoryAppId(
      "dev.shellcanvas.assistant",
      "dev.shellcanvas.assistant",
      "recommendation",
    ),
  ).not.toThrow();
  expect(() =>
    assertRepositoryAppId(
      "dev.attacker.replacement",
      "dev.shellcanvas.assistant",
      "recommendation",
    ),
  ).toThrow("recommended repository points to a different app");
});

it("loads updates only from the fixed ShellCanvas main catalog", async () => {
  const updated = clone();
  updated.apps[0].title = "Updated recommendation";
  const read = vi.fn<RepositoryReader>(async () => JSON.stringify(updated));
  const loader = new FirstPartyCatalogLoader(read);
  let visible = firstPartyCatalog;

  await expect(loader.refresh((catalog) => (visible = catalog))).resolves.toBe(
    true,
  );
  expect(read).toHaveBeenCalledWith(
    FIRST_PARTY_CATALOG_LOCATION,
    FIRST_PARTY_CATALOG_PATH,
    FIRST_PARTY_CATALOG_LIMIT,
    expect.any(AbortSignal),
  );
  expect(visible.apps[0].title).toBe("Updated recommendation");
});

it("keeps the bundled fallback for unavailable or invalid live catalogs", async () => {
  const foreign = clone();
  foreign.apps[0].source.owner = "someone-else";
  const duplicate = clone();
  duplicate.apps.push({ ...duplicate.apps[0] });
  for (const response of [
    "not json",
    JSON.stringify(foreign),
    JSON.stringify(duplicate),
    new Error("offline"),
  ]) {
    const read = vi.fn<RepositoryReader>(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    const loader = new FirstPartyCatalogLoader(read);
    let visible = firstPartyCatalog;
    await expect(
      loader.refresh((catalog) => (visible = catalog)),
    ).resolves.toBe(false);
    expect(visible).toBe(firstPartyCatalog);
  }
});

it("does not apply superseded or cancelled catalog reads", async () => {
  const pending: Array<(value: string) => void> = [];
  const read: RepositoryReader = () =>
    new Promise((resolve) => pending.push(resolve));
  const loader = new FirstPartyCatalogLoader(read);
  const accepted: string[] = [];
  const first = loader.refresh((catalog) => accepted.push(catalog.title));
  const second = loader.refresh((catalog) => accepted.push(catalog.title));
  const newer = clone();
  newer.title = "Newer";
  pending[1](JSON.stringify(newer));
  await expect(second).resolves.toBe(true);
  pending[0](JSON.stringify(firstPartyCatalog));
  await expect(first).resolves.toBe(false);

  const cancelled = loader.refresh((catalog) => accepted.push(catalog.title));
  loader.cancel();
  pending[2](JSON.stringify(firstPartyCatalog));
  await expect(cancelled).resolves.toBe(false);
  expect(accepted).toEqual(["Newer"]);
});
