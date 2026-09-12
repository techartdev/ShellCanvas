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
import type { ConnectOptions, HostProfile, HostKeyChallenge } from "../sdk";
import { HostProfilePicker } from "./HostProfilePicker";
import { HostKeyReviewPanel } from "./HostKeyReviewPanel";
export function ConnectDialog({
  profiles,
  profilesError,
  profilesLoading,
  reloadProfiles,
  busy,
  error,
  close,
  submit,
  preview,
  save,
  remove,
  initialProfile,
  reconnecting = false,
  cancelConnect,
  hostKeyReview,
  openAdapters,
}: {
  hostKeyReview?: {
    challenge: HostKeyChallenge;
    decide(approve: boolean): void;
  } | null;
  reconnecting?: boolean;
  cancelConnect?(): void;
  openAdapters?(): void;
  initialProfile?: HostProfile;
  profiles: HostProfile[];
  profilesError?: string;
  profilesLoading?: boolean;
  reloadProfiles?(): void;
  busy: boolean;
  error: string;
  close(): void;
  submit(options: ConnectOptions, label: string): void;
  preview: boolean;
  save(profile: HostProfile): Promise<HostProfile>;
  remove(id: string): Promise<void>;
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
  const [selected, setSelected] = useState("");
  const [savedId, setSavedId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const locked = busy || saving;
  const [method, setMethod] = useState("key");
  function select(profile: HostProfile) {
    setOptions({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      keyPath: profile.keyPath,
      allowLegacyMac: profile.allowLegacyMac ?? false,
      password: "",
      passphrase: "",
    });
    setLabel(profile.name);
    setSavedId(profile.id);
    setSaveMessage("");
    setSaveError("");
    setConfirmRemove(false);
    setMethod(profile.keyPath ? "key" : "password");
  }
  useEffect(() => {
    if (initialProfile) {
      select(initialProfile);
      const index = profiles.indexOf(initialProfile);
      setSelected(initialProfile.id ?? `import-${index}`);
    } else if (profiles[0]) {
      select(profiles[0]);
      setSelected(profiles[0].id ?? "import-0");
    }
  }, []);
  function newProfile() {
    setSelected("");
    setSavedId(undefined);
    setLabel("");
    setMethod("key");
    setOptions({
      host: "",
      port: 22,
      username: "",
      keyPath: "",
      password: "",
      passphrase: "",
    });
    setSaveError("");
    setSaveMessage("");
    setConfirmRemove(false);
  }
  async function saveHost() {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const saved = await save({
        id: savedId,
        name: label || options.host,
        host: options.host,
        port: options.port,
        username: options.username,
        keyPath: method === "key" ? options.keyPath : "",
        ...(options.allowLegacyMac ? { allowLegacyMac: true } : {}),
      });
      setSavedId(saved.id);
      setSelected(saved.id!);
      setLabel(saved.name);
      setSaveMessage("Host saved on this device.");
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  }
  async function removeHost() {
    if (!savedId) return;
    setSaving(true);
    setSaveError("");
    try {
      await remove(savedId);
      newProfile();
      setSaveMessage(
        "Saved host removed. Remote host and SSH config are unchanged.",
      );
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  }
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
      if (e.key === "Escape" && !saving) {
        if (busy) cancelConnect?.();
        close();
      }
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [busy, saving, close, cancelConnect]);
  function field(name: keyof ConnectOptions, value: string | number) {
    setSaveMessage("");
    setOptions((old) => ({ ...old, [name]: value }));
  }
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        // A click can target the backdrop after a text-selection drag ends
        // outside the dialog. Only a press that starts here should dismiss it.
        if (e.button === 0 && e.target === e.currentTarget && !locked) close();
      }}
    >
      <dialog
        ref={dialog}
        open
        aria-modal="true"
        className={`connect-dialog${hostKeyReview ? " connect-dialog-review" : ""}`}
        aria-labelledby="connect-title"
      >
        <button
          className="dialog-close icon-button"
          aria-label="Close connection dialog"
          disabled={saving}
          onClick={() => {
            if (busy) cancelConnect?.();
            close();
          }}
        >
          <X size={19} />
        </button>
        {!hostKeyReview && (
          <div className="connection-emblem">
            <Server size={25} />
            <span>
              <ShieldCheck size={12} />
            </span>
          </div>
        )}
        <p className="eyebrow">A WORKSPACE, ANYWHERE</p>
        <h1 id="connect-title">
          {hostKeyReview
            ? "Verify this host."
            : reconnecting
              ? "Pick up where you left off."
              : "Make yourself at home."}
        </h1>
        <p className="dialog-intro">
          {hostKeyReview
            ? "A familiar workspace starts with a trusted connection."
            : reconnecting
              ? "Reconnect this host with your windows and drafts intact. Terminal windows open fresh shells."
              : "Connect to your host. Everything stays on your machine."}
        </p>
        {hostKeyReview ? (
          <HostKeyReviewPanel
            key={hostKeyReview.challenge.token}
            {...hostKeyReview}
          />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(
                {
                  ...options,
                  keyPath: method === "key" ? options.keyPath : "",
                  password:
                    method === "password" ? options.password : undefined,
                  passphrase: method === "key" ? options.passphrase : undefined,
                },
                label || options.host,
              );
            }}
          >
            {openAdapters && !reconnecting && (
              <button
                type="button"
                className="adapter-add"
                disabled={locked}
                onClick={openAdapters}
              >
                Use connection adapters
              </button>
            )}
            {profilesLoading && (
              <p className="profile-message" role="status">
                Loading saved hosts…
              </p>
            )}
            {profilesError && (
              <div className="inline-error" role="alert">
                <span>Saved hosts could not be refreshed. {profilesError}</span>
                <button
                  type="button"
                  disabled={profilesLoading}
                  onClick={reloadProfiles}
                >
                  Retry
                </button>
              </div>
            )}
            <fieldset disabled={locked || preview}>
              {!reconnecting && (
                <HostProfilePicker
                  profiles={profiles}
                  disabled={locked || preview}
                  value={selected}
                  onChange={(value) => {
                    if (!value) {
                      newProfile();
                      return;
                    }
                    const profile = profiles.find(
                      (p, i) => (p.id ?? `import-${i}`) === value,
                    );
                    if (profile) {
                      select(profile);
                      setSelected(value);
                    }
                  }}
                />
              )}
              <label className="form-field">
                Name <span className="optional">optional</span>
                <input
                  placeholder="My server"
                  value={label}
                  onChange={(e) => {
                    setLabel(e.target.value);
                    setSaveMessage("");
                  }}
                />
              </label>
              <div className="form-row">
                <label className="form-field grow">
                  Host
                  <input
                    autoFocus
                    required
                    placeholder="server.example.com"
                    value={options.host}
                    readOnly={reconnecting}
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
                    readOnly={reconnecting}
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
                  readOnly={reconnecting}
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
              <div className="ssh-compatibility">
                <label>
                  <input
                    type="checkbox"
                    checked={options.allowLegacyMac ?? false}
                    onChange={(event) =>
                      setOptions((current) => ({
                        ...current,
                        allowLegacyMac: event.target.checked,
                      }))
                    }
                  />
                  Allow legacy SSH compatibility
                </label>
                {options.allowLegacyMac && (
                  <p role="status">
                    Legacy compatibility enabled for this host. Modern
                    algorithms stay preferred; HMAC-SHA1, RSA/SHA1
                    authentication and 2048-bit exchange groups are allowed when
                    needed. MD5 remains disabled.
                  </p>
                )}
                {!options.allowLegacyMac &&
                  error.includes("No common Mac algorithm") && (
                    <p>
                      This host offers no matching SSH MAC. Enable compatibility
                      only if this older host requires it, or configure stronger
                      SSH algorithms on the host.
                    </p>
                  )}
              </div>
              <div className="profile-actions">
                <button
                  type="button"
                  disabled={
                    !options.host.trim() ||
                    !options.username.trim() ||
                    !Number.isInteger(options.port) ||
                    options.port < 1 ||
                    options.port > 65535 ||
                    (method === "key" && !options.keyPath.trim())
                  }
                  onClick={() => void saveHost()}
                >
                  {savedId ? "Update saved host" : "Save host"}
                </button>
                {savedId && (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(!confirmRemove)}
                  >
                    Remove saved host
                  </button>
                )}
              </div>
              {confirmRemove && (
                <div className="profile-removal">
                  <span>Remove this saved connection?</span>
                  <button type="button" onClick={() => void removeHost()}>
                    Remove
                  </button>
                  <button type="button" onClick={() => setConfirmRemove(false)}>
                    Keep
                  </button>
                </div>
              )}
            </fieldset>
            {saveMessage && (
              <p className="profile-message" role="status">
                {saveMessage}
              </p>
            )}
            {saveError && (
              <div className="inline-error" role="alert">
                {saveError}
              </div>
            )}
            {error && (
              <div role="alert" className="inline-error">
                {error}
              </div>
            )}
            {preview && (
              <div className="preview-explanation">
                You’re viewing the desktop design preview. Open the native app
                to connect to a real SSH host.
              </div>
            )}
            <button
              className="primary-button connect-submit"
              type="submit"
              disabled={locked || preview}
            >
              {busy ? (
                <>
                  <LoaderCircle size={16} className="spin" /> Verifying host &
                  connecting…
                </>
              ) : (
                <>
                  {reconnecting ? "Reconnect workspace" : "Open workspace"}{" "}
                  <ArrowUpRight size={17} />
                </>
              )}
            </button>
            {busy && cancelConnect && (
              <button
                type="button"
                className="cancel-connection"
                onClick={cancelConnect}
              >
                Cancel connection
              </button>
            )}
          </form>
        )}
        <p className="trust-note">
          <ShieldCheck size={15} />
          <span>
            Checked against OpenSSH and ShellCanvas trusted host keys.
            <br />
            Passwords and passphrases are never saved.
          </span>
        </p>
      </dialog>
    </div>
  );
}
