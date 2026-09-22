// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import type { InstalledApp } from "./catalog";
import {
  firstPartyCatalog,
  firstPartyRecommendations,
  parseFirstPartyCatalog,
} from "./first-party-catalog";
import { assertRepositoryAppId } from "./repository";

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
