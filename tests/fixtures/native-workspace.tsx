// SPDX-License-Identifier: MPL-2.0
// Explicit native-test entry point, never imported by the production desktop.
// The ignored local configuration contains only the authorized test connection.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { native, nativeServices } from "../../src/services";
import { connectionProfile } from "../../src/workspaces";
import type { ConnectOptions } from "../../src/sdk";
import "../../src/styles.css";
const root = createRoot(document.getElementById("root")!);
async function boot() {
  if (!native)
    throw new Error(
      "Launch this fixture through the native test configuration.",
    );
  const response = await fetch("/.local/native-workspace.json");
  if (!response.ok) throw new Error("Missing local native-test configuration.");
  const { connection } = (await response.json()) as {
    connection: ConnectOptions;
  };
  const session = await nativeServices.connect(connection);
  root.render(
    <App
      services={nativeServices}
      isNative
      initialSession={session}
      initialConnection={connectionProfile(
        connection,
        "Native integration probe",
      )}
    />,
  );
}
root.render(
  <p style={{ padding: 24 }}>Opening the configured native test workspace…</p>,
);
void boot().catch((error) =>
  root.render(
    <p role="alert" style={{ padding: 24 }}>
      {String(error)}
    </p>,
  ),
);
