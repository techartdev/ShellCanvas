// SPDX-License-Identifier: MPL-2.0
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { previewSession } from "../../src/preview";
import "../../src/styles.css";

// Synthetic browser preview only. No native backend is present in this fixture.
previewSession.info = {
  ...previewSession.info,
  provider: "fixture-console",
  system: "Limited device · fixture",
  capabilities: ["terminal"],
  home: null,
};
createRoot(document.getElementById("root")!).render(<App />);
