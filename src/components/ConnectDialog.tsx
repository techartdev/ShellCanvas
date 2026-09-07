// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ConnectOptions, HostProfile } from "../sdk";
export function ConnectDialog({
  profiles,
  busy,
  error,
  close,
  submit,
  preview,
}: {
  profiles: HostProfile[];
  busy: boolean;
  error: string;
  close(): void;
  submit(options: ConnectOptions, label: string): void;
  preview: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<ConnectOptions>({
    host: "",
    port: 22,
    username: "",
    keyPath: "",
    password: "",
    passphrase: "",
  });
  const [label, setLabel] = useState("");
  const [method, setMethod] = useState("key");
  function select(profile: HostProfile) {
    setOptions({ ...profile, password: "", passphrase: "" });
    setLabel(profile.name);
    setMethod(profile.keyPath ? "key" : "password");
  }
  useEffect(() => {
    if (profiles[0]) select(profiles[0]);
  }, [profiles]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const controls = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
        ) || [],
      );
    controls()[0]?.focus();
    function trap(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const elements = controls();
      const first = elements[0];
      const last = elements.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) close();
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [busy, close]);
  function field(name: keyof ConnectOptions, value: string | number) {
    setOptions((old) => ({ ...old, [name]: value }));
  }
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <dialog
        ref={dialog}
        open
        aria-modal="true"
        className="connect-dialog"
        aria-labelledby="connect-title"
      >
        <button
          className="dialog-close icon-button"
          aria-label="Close connection dialog"
          disabled={busy}
          onClick={close}
        >
          <X size={19} />
        </button>
        <div className="connection-emblem">
          <Server size={25} />
          <span>
            <ShieldCheck size={12} />
          </span>
        </div>
        <p className="eyebrow">A WORKSPACE, ANYWHERE</p>
        <h1 id="connect-title">Make yourself at home.</h1>
        <p className="dialog-intro">
          Connect to your host. Everything stays on your machine.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(
              {
                ...options,
                keyPath: method === "key" ? options.keyPath : "",
                password: method === "password" ? options.password : undefined,
                passphrase: method === "key" ? options.passphrase : undefined,
              },
              label || options.host,
            );
          }}
        >
          <fieldset disabled={busy || preview}>
            {profiles.length > 0 && (
              <label className="form-field">
                From your SSH config
                <select
                  aria-label="SSH profile"
                  onChange={(e) => select(profiles[Number(e.target.value)])}
                >
                  {profiles.map((p, i) => (
                    <option key={`${p.name}-${i}`} value={i}>
                      {p.name} · {p.host}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="form-row">
              <label className="form-field grow">
                Host
                <input
                  autoFocus
                  required
                  placeholder="server.example.com"
                  value={options.host}
                  onChange={(e) => field("host", e.target.value)}
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>
              <label className="form-field port">
                Port
                <input
                  required
                  type="number"
                  min="1"
                  max="65535"
                  value={options.port}
                  onChange={(e) => field("port", Number(e.target.value))}
                />
              </label>
            </div>
            <label className="form-field">
              Username
              <input
                required
                placeholder="Your remote username"
                value={options.username}
                onChange={(e) => field("username", e.target.value)}
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <div className="auth-tabs">
              <button
                type="button"
                className={method === "key" ? "active" : ""}
                onClick={() => setMethod("key")}
              >
                <KeyRound size={14} /> SSH key
              </button>
              <button
                type="button"
                className={method === "password" ? "active" : ""}
                onClick={() => setMethod("password")}
              >
                <LockKeyhole size={14} /> Password
              </button>
            </div>
            {method === "key" ? (
              <>
                <label className="form-field">
                  Private key path
                  <input
                    required
                    placeholder="~/.ssh/id_ed25519"
                    value={options.keyPath}
                    onChange={(e) => field("keyPath", e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <label className="form-field">
                  Key passphrase <span className="optional">optional</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={options.passphrase}
                    onChange={(e) => field("passphrase", e.target.value)}
                  />
                </label>
              </>
            ) : (
              <label className="form-field">
                Password
                <input
                  type="password"
                  required
                  autoComplete="off"
                  value={options.password}
                  onChange={(e) => field("password", e.target.value)}
                />
              </label>
            )}
          </fieldset>
          {error && (
            <div role="alert" className="inline-error">
              {error}
            </div>
          )}
          {preview && (
            <div className="preview-explanation">
              You’re viewing the desktop design preview. Open the native app to
              connect to a real SSH host.
            </div>
          )}
          <button
            className="primary-button connect-submit"
            type="submit"
            disabled={busy || preview}
          >
            {busy ? (
              <>
                <LoaderCircle size={16} className="spin" /> Verifying host &
                connecting…
              </>
            ) : (
              <>
                Open workspace <ArrowUpRight size={17} />
              </>
            )}
          </button>
        </form>
        <p className="trust-note">
          <ShieldCheck size={15} />
          <span>
            Verified against your existing known_hosts.
            <br />
            Passwords and passphrases are never saved.
          </span>
        </p>
      </dialog>
    </div>
  );
}
