// SPDX-License-Identifier: MPL-2.0
/** The ShellCanvas client target, never the connected remote host's OS. */
export const clientPlatforms = [
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
  "web",
] as const;
export type ClientPlatform = (typeof clientPlatforms)[number];
export interface ClientEnvironment {
  readonly platform: ClientPlatform | "unknown";
}
export const clientPlatformLabels: Readonly<
  Record<ClientEnvironment["platform"], string>
> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
  web: "Web",
  unknown: "Unknown client",
};
/** Omission means no platform restriction, not a certification of compatibility. */
export function clientCompatibilityReason(
  app: { readonly clientPlatforms?: readonly ClientPlatform[] },
  client: ClientEnvironment,
): string | undefined {
  if (
    !app.clientPlatforms ||
    app.clientPlatforms.some((platform) => platform === client.platform)
  )
    return;
  return `Not available on ${clientPlatformLabels[client.platform]}. Supports ${app.clientPlatforms.map((platform) => clientPlatformLabels[platform]).join(", ")} clients.`;
}
