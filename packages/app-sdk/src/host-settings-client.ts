// SPDX-License-Identifier: MPL-2.0
import type { RpcPeer } from "./rpc.js";

/** Presentation, validation choices and revisions belong to the device provider. */
export interface HostSetting {
  id: string;
  label: string;
  description: string;
  value: string | null;
  revision: string | null;
  editor: "text" | "select";
  choices: string[];
  writable: boolean;
  reason: string | null;
}
export interface RemoteHostSetting extends HostSetting {
  /** Accepted workspace binding, never a native session identifier. */
  binding: string;
}
export interface AppHostSettingsAPI {
  read(
    location: { binding: string },
    signal?: AbortSignal,
  ): Promise<RemoteHostSetting[]>;
  /** Submit one proposed value with its captured revision; failures are never retried. */
  apply(
    setting: Pick<RemoteHostSetting, "binding" | "id" | "revision">,
    value: string,
    signal?: AbortSignal,
  ): Promise<RemoteHostSetting>;
}
export function appHostSettingsClient(peer: RpcPeer): AppHostSettingsAPI {
  return {
    read: async (location, signal) =>
      (await peer.call(
        "system.hostSettings.read",
        { binding: location.binding },
        signal,
      )) as unknown as RemoteHostSetting[],
    apply: async (setting, value, signal) =>
      (await peer.call(
        "system.hostSettings.apply",
        {
          binding: setting.binding,
          id: setting.id,
          revision: setting.revision,
          value,
        },
        signal,
      )) as unknown as RemoteHostSetting,
  };
}
