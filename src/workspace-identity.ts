// SPDX-License-Identifier: MPL-2.0
import { isAdapterProfile, type WorkspaceConnection } from "./workspaces";

/** Conversation identity, not authentication or a live service routing token.
 * Labels, credentials and ephemeral connection generations are not SSH targets.
 * Composite configurations are conservative: any configuration/routing change
 * produces a different identity. Raw configuration never crosses the app SDK.
 */
export async function workspaceIdentity(
  connection?: WorkspaceConnection,
): Promise<string | null> {
  if (!connection) return null;
  const target = isAdapterProfile(connection)
    ? [
        "adapters",
        connection.sources
          .map((source) => [
            source.key,
            source.id,
            Object.entries(source.configuration).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        Object.entries(connection.bindings).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ]
    : [
        "ssh",
        connection.host.trim().toLowerCase(),
        connection.port,
        connection.username,
      ];
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(target)),
  );
  return (
    "workspace-v1-" +
    Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}
