// SPDX-License-Identifier: MPL-2.0
import "./platform-compat";
import { prepareDialogs } from "./dialog-compat";
import "./styles.css";
import "./legacy-layout.css";

// Finish compatibility setup before libraries with module-level side effects,
// including xterm's media-query listeners, evaluate in separate chunks.
void prepareDialogs()
  .then(() => import("./desktop-entry"))
  .catch((error: unknown) => {
    console.error("ShellCanvas startup failed", error);
    const root = document.getElementById("root");
    if (root) {
      root.textContent = `ShellCanvas could not start: ${error instanceof Error ? error.message : String(error)}`;
      root.style.padding = "32px";
    }
  });
