// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { workspaceIdentity } from "./workspace-identity";
import type { HostProfile } from "./sdk";
import type { AdapterProfile } from "./adapters";
const ssh: HostProfile = {
  name: "Server",
  host: "EXAMPLE.test",
  port: 22,
  username: "root",
  keyPath: "key",
};
it("retains SSH identity across reconnects, labels and authentication changes, but separates targets and accounts", async () => {
  const id = await workspaceIdentity(ssh);
  expect(
    await workspaceIdentity({
      ...ssh,
      id: "saved",
      name: "Renamed",
      host: " example.TEST ",
      keyPath: "other",
    }),
  ).toBe(id);
  for (const change of [
    { host: "mac.test" },
    { username: "user" },
    { port: 2222 },
  ])
    expect(await workspaceIdentity({ ...ssh, ...change })).not.toBe(id);
  expect(id).not.toContain("example");
  expect(await workspaceIdentity()).toBeNull();
});
it("identifies composite targets independent of ordering but detects routing and source changes", async () => {
  const profile: AdapterProfile = {
    kind: "adapters",
    name: "Composite",
    sources: [
      {
        key: "files",
        id: "ftp",
        revision: "1",
        configuration: { host: "a", port: 21 },
      },
      {
        key: "shell",
        id: "serial",
        revision: "1",
        configuration: { port: "COM1" },
      },
    ],
    bindings: { "files.read": "files", terminal: "shell" },
  };
  const id = await workspaceIdentity(profile);
  expect(
    await workspaceIdentity({
      ...profile,
      name: "Renamed",
      sources: [...profile.sources].reverse(),
    }),
  ).toBe(id);
  expect(
    await workspaceIdentity({
      ...profile,
      bindings: { ...profile.bindings, terminal: "files" },
    }),
  ).not.toBe(id);
  expect(
    await workspaceIdentity({
      ...profile,
      sources: [
        profile.sources[0],
        { ...profile.sources[1], configuration: { port: "COM2" } },
      ],
    }),
  ).not.toBe(id);
});
