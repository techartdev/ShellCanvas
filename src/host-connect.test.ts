// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  matchesSavedHost,
  openHostWorkspace,
  type SavedHostConnection,
} from "./host-connect";

const request = {
  options: {
    host: " host.example ",
    port: 22,
    username: "alice",
    keyPath: "",
    password: "entered-password",
  },
  label: "Host",
  method: "password",
  saveFirst: true,
  useStored: false,
};
const profile = {
  host: "host.example",
  port: 22,
  username: "alice",
  keyPath: "",
  name: "Saved host",
  id: "saved-id",
};

it.each(["password", "key"])(
  "saves an entered %s secret before connecting without passing plaintext",
  async (method) => {
    let finish!: (result: SavedHostConnection) => void;
    const save = vi.fn(
      () =>
        new Promise<SavedHostConnection>((resolve) => {
          finish = resolve;
        }),
    );
    const submit = vi.fn();
    const options = {
      ...request.options,
      keyPath: method === "key" ? "~/.ssh/key" : "",
      passphrase: method === "key" ? "entered-passphrase" : undefined,
    };
    const pending = openHostWorkspace(
      { ...request, options, method },
      save,
      submit,
    );
    expect(save).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    finish({
      profile: { ...profile, keyPath: options.keyPath },
      credentialStored: true,
    });
    await pending;
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "host.example",
        keyPath: options.keyPath,
        password: undefined,
        passphrase: undefined,
      }),
      "Saved host",
      "saved-id",
    );
  },
);

it("keeps the dialog open when saving fails", async () => {
  const submit = vi.fn();
  await openHostWorkspace(request, async () => undefined, submit);
  expect(submit).not.toHaveBeenCalled();
});

it("allows a one-time connection without writing the profile or credential", async () => {
  const save = vi.fn();
  const submit = vi.fn();
  await openHostWorkspace({ ...request, saveFirst: false }, save, submit);
  expect(save).not.toHaveBeenCalled();
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ password: "entered-password" }),
    "Host",
    undefined,
  );
});

it("connects an unchanged saved host without saving again", async () => {
  const save = vi.fn();
  const submit = vi.fn();
  await openHostWorkspace(
    {
      ...request,
      options: { ...request.options, password: "" },
      saveFirst: false,
      useStored: true,
      savedId: profile.id,
    },
    save,
    submit,
  );
  expect(save).not.toHaveBeenCalled();
  expect(submit.mock.calls[0][2]).toBe(profile.id);
  expect(submit.mock.calls[0][0].host).toBe(profile.host);
});

it("saves an unencrypted key connection without requesting a nonexistent credential", async () => {
  const submit = vi.fn();
  const keyProfile = { ...profile, keyPath: "~/.ssh/key" };
  await openHostWorkspace(
    {
      ...request,
      method: "key",
      options: {
        ...request.options,
        keyPath: keyProfile.keyPath,
        password: "",
        passphrase: "",
      },
    },
    async () => ({ profile: keyProfile, credentialStored: false }),
    submit,
  );
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      keyPath: keyProfile.keyPath,
      password: undefined,
      passphrase: "",
    }),
    "Saved host",
    undefined,
  );
});

it("preserves saved credentials on a name-only update", async () => {
  const submit = vi.fn();
  await openHostWorkspace(
    {
      ...request,
      options: { ...request.options, password: "" },
      useStored: true,
      savedId: profile.id,
    },
    async () => ({
      profile: { ...profile, name: "Renamed" },
      credentialStored: true,
    }),
    submit,
  );
  expect(submit.mock.calls[0].slice(1)).toEqual(["Renamed", profile.id]);
});

it("only offers a saved secret for matching endpoint and authentication settings", () => {
  expect(matchesSavedHost(request.options, "password", profile)).toBe(true);
  for (const patch of [
    { host: "other.example" },
    { port: 2222 },
    { username: "bob" },
    { allowLegacyMac: true },
  ]) {
    expect(
      matchesSavedHost({ ...request.options, ...patch }, "password", profile),
    ).toBe(false);
  }
  expect(
    matchesSavedHost(
      { ...request.options, keyPath: "~/.ssh/key" },
      "key",
      profile,
    ),
  ).toBe(false);
  expect(matchesSavedHost(request.options, "password", undefined)).toBe(false);
});
