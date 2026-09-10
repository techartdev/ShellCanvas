// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectDialog } from "../../src/components/ConnectDialog";
import type { HostProfile } from "../../src/sdk";
import "../../src/styles.css";

function Fixture() {
  const [profiles, setProfiles] = useState<HostProfile[]>(() =>
    new URLSearchParams(location.search).has("many")
      ? Array.from({ length: 80 }, (_, i) => ({
          id: i < 40 ? `fixture-${i}` : undefined,
          name: `${i < 40 ? "Production" : "Lab"} ${i + 1}`,
          host: `node-${i + 1}.example.test`,
          username: i < 40 ? "deploy" : "root",
          port: i < 40 ? 22 : 2222,
          keyPath: "~/.ssh/fixture-key",
        }))
      : [],
  );
  const [open, setOpen] = useState(true);
  const [loadError, setLoadError] = useState(new URLSearchParams(location.search).has("load-error") ? "Fixture read failed" : "");
  const [leaked, setLeaked] = useState(false);
  const [submitted, setSubmitted] = useState(0);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open host manager fixture</button>
      <p>
        Saved profiles: {profiles.length} · Secret fields sent to store:{" "}
        {String(leaked)}
        {" · Connection submissions: "}
        {submitted}
      </p>
      {open && (
        <ConnectDialog
          profiles={profiles}
          profilesError={loadError}
          reloadProfiles={() => {
            setLoadError("");
            setProfiles([{ id: "fixture-recovered", name: "Recovered Mac", host: "mac.example.test", port: 22, username: "user", keyPath: "" }]);
          }}
          busy={false}
          preview={false}
          error=""
          close={() => setOpen(false)}
          submit={() => setSubmitted((old) => old + 1)}
          save={async (profile) => {
            setLeaked("password" in profile || "passphrase" in profile);
            const saved = { ...profile, id: profile.id ?? crypto.randomUUID() };
            setProfiles((old) => [
              ...old.filter((p) => p.id !== saved.id),
              saved,
            ]);
            return saved;
          }}
          remove={async (id) =>
            setProfiles((old) => old.filter((p) => p.id !== id))
          }
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
