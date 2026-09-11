// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { Store } from "lucide-react";
import { defaultAdapterServices, type AdapterServices } from "../adapters";
import { AdapterManager } from "./AdapterManager";
import {
  ExtensionManager,
  ManagerTabs,
  managerPages,
  type ManagerPage,
} from "./ExtensionManager";
import type { AppCatalog } from "./catalog";
import "./ExtensionManager.css";
import "./AppManager.css";

type Tab = ManagerPage | "adapters";

export function ExtensionCenter({
  catalog,
  open,
  adapters = defaultAdapterServices,
}: {
  catalog: AppCatalog;
  open?(id: string): void;
  adapters?: AdapterServices;
}) {
  const [tab, setTab] = useState<Tab>("installed");
  const [visit, setVisit] = useState(0);
  const tabs: readonly (readonly [Tab, string])[] = adapters
    ? [...managerPages, ["adapters", "Connection adapters"]]
    : managerPages;
  return (
    <div className="extension-center app-manager">
      <header className="app-manager-header">
        <div className="app-manager-heading">
          <span className="app-manager-mark" aria-hidden="true">
            <Store size={18} />
          </span>
          <div>
            <h2>App Manager</h2>
            <p>Add, update and manage your apps</p>
          </div>
        </div>
        <ManagerTabs
          tabs={tabs}
          current={tab}
          select={(next) => {
            setTab(next);
            setVisit((count) => count + 1);
          }}
        />
      </header>
      {tab === "adapters" && adapters ? (
        <AdapterManager services={adapters} />
      ) : (
        <ExtensionManager
          catalog={catalog}
          open={open}
          page={tab === "adapters" ? "installed" : tab}
          navigate={setTab}
          visit={visit}
        />
      )}
    </div>
  );
}
