// SPDX-License-Identifier: MPL-2.0
import { capabilityLabels, type Capability } from "../sdk";

/** Public grants and device capabilities are separate contracts. */
export function appCapabilities(grants: readonly string[]): Capability[] {
  return [
    ...new Set(
      grants.flatMap((grant): Capability[] => {
        if (grant === "system.console") return ["terminal"];
        if (grant === "host.settings.read" || grant === "host.settings.write")
          return ["host.settings"];
        return Object.hasOwn(capabilityLabels, grant)
          ? [grant as Capability]
          : [];
      }),
    ),
  ];
}
