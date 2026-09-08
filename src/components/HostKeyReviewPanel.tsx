// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { Copy, ShieldCheck } from "lucide-react";
import type { HostKeyChallenge } from "../sdk";
import { clipboard } from "../clipboard";
import "./HostKeyReviewPanel.css";

export function HostKeyReviewPanel({
  challenge,
  decide,
}: {
  challenge: HostKeyChallenge;
  decide(approve: boolean): void;
}) {
  const [verified, setVerified] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus({ preventScroll: true });
  }, []);
  async function copy() {
    try {
      await clipboard.writeText(challenge.fingerprint);
      setCopied(true);
      setError("");
    } catch (error) {
      setError(`Could not copy fingerprint: ${error}`);
    }
  }
  return (
    <section className="host-key-review" aria-label="Host identity review">
      <div className="host-key-endpoint">
        <strong>{challenge.host}</strong>
        <span>
          Port {challenge.port} · {challenge.algorithm}
        </span>
      </div>
      <p>
        This host key is new to this device. Compare its fingerprint with your
        server provider or another trusted source before connecting.
      </p>
      <div className="host-key-fingerprint">
        <span>SHA-256 FINGERPRINT</span>
        <code>{challenge.fingerprint}</code>
        <button type="button" onClick={() => void copy()}>
          <Copy size={13} />
          {copied ? "Copied" : "Copy fingerprint"}
        </button>
      </div>
      <label className="host-key-confirmation">
        <input
          type="checkbox"
          checked={verified}
          onChange={(event) => setVerified(event.target.checked)}
        />
        <span>I checked this fingerprint using a trusted source.</span>
      </label>
      <p className="host-key-storage">
        Trust is saved in ShellCanvas on this device. Future connections must
        present this key. Your OpenSSH known_hosts file is unchanged.
      </p>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      <div className="host-key-buttons">
        <button type="button" ref={cancel} onClick={() => decide(false)}>
          Cancel connection
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!verified}
          onClick={() => decide(true)}
        >
          <ShieldCheck size={16} /> Trust and connect
        </button>
      </div>
    </section>
  );
}
