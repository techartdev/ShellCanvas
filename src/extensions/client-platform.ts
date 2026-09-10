// SPDX-License-Identifier: MPL-2.0
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  clientPlatforms,
  type ClientEnvironment,
} from "../../packages/app-sdk/src/client-platform";

/** Native builds report their compile target; browser previews are always web. */
export async function readClientEnvironment(): Promise<ClientEnvironment> {
  if (!isTauri()) return Object.freeze({ platform: "web" });
  const platform = await invoke<string>("client_platform");
  return Object.freeze({
    platform: clientPlatforms.find((value) => value === platform) ?? "unknown",
  });
}
