// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { defaultAdapterServices, type AdapterServices } from "../adapters";
import { AdapterManager } from "./AdapterManager";
import { ExtensionManager } from "./ExtensionManager";
import type { AppCatalog } from "./catalog";
import "./ExtensionManager.css";
export function ExtensionCenter({
  catalog,
  open,
  adapters = defaultAdapterServices,
}: {
  catalog: AppCatalog;
  open?(id: string): void;
  adapters?: AdapterServices;
}) {
  const [tab, setTab] = useState("apps");
  return (
    <div className="extension-center">
      {adapters && (
        <nav className="extension-tabs" aria-label="Extension type">
          <button aria-pressed={tab === "apps"} onClick={() => setTab("apps")}>
            Desktop apps
          </button>
          <button
            aria-pressed={tab === "adapters"}
            onClick={() => setTab("adapters")}
          >
            Connection adapters
          </button>
        </nav>
      )}
      {tab === "adapters" && adapters ? (
        <AdapterManager services={adapters} />
      ) : (
        <ExtensionManager catalog={catalog} open={open} />
      )}
    </div>
  );
}
