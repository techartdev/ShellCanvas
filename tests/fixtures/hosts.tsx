// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectDialog } from "../../src/components/ConnectDialog";
import type { HostProfile } from "../../src/sdk";
import "../../src/styles.css";

function Fixture() {
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [open, setOpen] = useState(true);
  const [leaked, setLeaked] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open host manager fixture</button>
      <p>
        Saved profiles: {profiles.length} · Secret fields sent to store:{" "}
        {String(leaked)}
      </p>
      {open && (
        <ConnectDialog
          profiles={profiles}
          busy={false}
          preview={false}
          error=""
          close={() => setOpen(false)}
          submit={() => {}}
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
