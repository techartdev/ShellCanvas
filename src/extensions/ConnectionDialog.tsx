// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, ShieldCheck } from "lucide-react";
import { showModal } from "../dialog-compat";
import { nativeNetwork, type ConnectionPrompt } from "./network-bridge";
import type { AppConnection } from "../../packages/app-sdk/src/network-client";
import "./ConnectionDialog.css";
export function ConnectionDialog({
  request,
  finish,
}: {
  request: ConnectionPrompt;
  finish(value: AppConnection | null): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [endpoint, setEndpoint] = useState(request.suggestedEndpoint);
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(true);
  const [original, setOriginal] = useState<AppConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    showModal(ref.current);
    let current = true;
    void nativeNetwork
      .profile(request.app, request.slot)
      .then((profile) => {
        if (!current) return;
        setOriginal(profile);
        if (profile) {
          setEndpoint(profile.endpoint);
          setRemember(profile.remembered);
        }
      })
      .catch((error) => {
        if (current) setError(String(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [request]);
  return createPortal(
    <dialog
      ref={ref}
      className="app-connection-dialog"
      aria-label={`Connection for ${request.title}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) finish(null);
      }}
    >
      <div className="app-connection-icon">
        <KeyRound size={25} />
      </div>
      <p className="app-connection-eyebrow">SHELLCANVAS · APP CONNECTION</p>
      <h2>Connect {request.title}</h2>
      <p>
        The app can send requests to this endpoint. ShellCanvas holds the API
        key and adds it to requests.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || loading) return;
          setBusy(true);
          setError("");
          void invoke<AppConnection>("app_network_configure", {
            app: request.app,
            slot: request.slot,
            endpointUrl: endpoint.trim(),
            key:
              original?.hasKey && !key && endpoint.trim() === original.endpoint
                ? null
                : key,
            remember,
          })
            .then((value) => {
              setKey("");
              finish(value);
            })
            .catch((error) => setError(String(error)))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={loading || busy}>
          <label>
            Endpoint URL
            <input
              autoFocus
              required
              type="url"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://api.example.com/v1/chat/completions"
              spellCheck={false}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={
                original?.hasKey && endpoint.trim() === original.endpoint
                  ? "Leave blank to keep the saved key"
                  : "Optional for a local server"
              }
            />
          </label>
          <label className="app-connection-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>Remember in the system credential store</span>
          </label>
        </fieldset>
        {endpoint.trim().startsWith("http:") && (
          <p className="app-connection-warning">
            This HTTP endpoint is unencrypted. Use it only on a network you
            trust.
          </p>
        )}
        {error && (
          <p role="alert" className="app-connection-error">
            {error}
          </p>
        )}
        <p className="app-connection-note">
          <ShieldCheck size={15} />
          <span>
            Private to this installation of {request.title}. Your key stays out
            of app storage and conversation history.
          </span>
        </p>
        <div className="app-connection-actions">
          <button type="button" disabled={busy} onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="submit" disabled={busy || loading}>
            {busy ? "Saving…" : "Save connection"}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
