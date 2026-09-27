// SPDX-License-Identifier: MPL-2.0
import type { ConnectOptions, HostProfile } from "./sdk";

export interface SavedHostConnection {
  profile: HostProfile;
  credentialStored: boolean;
}

// A saved secret is only reusable for the connection it was saved with.
export function matchesSavedHost(
  options: ConnectOptions,
  method: string,
  profile?: HostProfile,
) {
  return (
    !!profile &&
    options.host.trim() === profile.host &&
    options.port === profile.port &&
    options.username.trim() === profile.username &&
    (method === "key" ? options.keyPath.trim() : "") === profile.keyPath &&
    !!options.allowLegacyMac === !!profile.allowLegacyMac
  );
}

export async function openHostWorkspace(
  request: {
    options: ConnectOptions;
    label: string;
    method: string;
    saveFirst: boolean;
    useStored: boolean;
    savedId?: string;
  },
  save: () => Promise<SavedHostConnection | undefined>,
  submit: (options: ConnectOptions, label: string, savedId?: string) => void,
) {
  const { options, method } = request;
  const result = request.saveFirst ? await save() : undefined;
  // A failed credential save must leave the dialog open, not silently connect.
  if (request.saveFirst && !result) return;
  const saved = result?.profile;
  const credentialId = result
    ? result.credentialStored
      ? saved?.id
      : undefined
    : request.useStored
      ? request.savedId
      : undefined;
  submit(
    {
      ...options,
      host: options.host.trim(),
      username: options.username.trim(),
      ...(saved
        ? {
            host: saved.host,
            port: saved.port,
            username: saved.username,
            allowLegacyMac: saved.allowLegacyMac,
          }
        : {}),
      keyPath: method === "key" ? (saved?.keyPath ?? options.keyPath.trim()) : "",
      password:
        method === "password" && !credentialId ? options.password : undefined,
      passphrase:
        method === "key" && !credentialId ? options.passphrase : undefined,
    },
    saved?.name || request.label || options.host,
    credentialId,
  );
}
