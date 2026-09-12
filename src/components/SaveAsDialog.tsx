// SPDX-License-Identifier: MPL-2.0
import { showModal } from "../dialog-compat";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FilePenLine, LoaderCircle } from "lucide-react";
import type { SessionServices, TextDocument } from "../sdk";
import { commitSaveAs, prepareSaveAs, type SaveDestination } from "../save-as";
import { nonAtomicSaveWarning } from "../text-save";
import "./FileActionDialog.css";

export function SaveAsDialog({
  initialParent,
  initialName,
  text,
  services,
  connected,
  canReplace,
  close,
  setBusy,
  saved,
}: {
  initialParent: string;
  initialName: string;
  text: string;
  services: SessionServices;
  connected: boolean;
  canReplace: boolean;
  close(): void;
  setBusy(value: boolean): void;
  saved(document: TextDocument): void;
}) {
  const [parent, setParent] = useState(initialParent);
  const [name, setName] = useState(initialName);
  const [review, setReview] = useState<SaveDestination | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const sequence = useRef(0);
  const running = useRef(false);
  const binding = useRef({ services, connected });
  binding.current = { services, connected };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    showModal(dialog.current);
    nameField.current?.select();
    return () => {
      ++sequence.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (running.current)
      setError(
        "The connection changed during saving. Check the destination before trying again; your draft is kept.",
      );
    ++sequence.current;
    running.current = false;
    setWorking(false);
    setBusy(false);
    setReview(null);
  }, [services, connected, canReplace]);
  useEffect(() => {
    if (review) backButton.current?.focus();
  }, [review]);
  async function submit() {
    if (running.current || !connected) return;
    const current = ++sequence.current;
    const currentBinding = () =>
      current === sequence.current &&
      binding.current.services === services &&
      binding.current.connected;
    running.current = true;
    setWorking(true);
    setBusy(true);
    setError("");
    try {
      const destination =
        review ?? (await prepareSaveAs(services, parent, name, canReplace));
      if (!currentBinding()) return;
      if (!review && destination.kind === "replace") {
        setReview(destination);
        return;
      }
      const result = await commitSaveAs(
        services,
        destination,
        text,
        !!review &&
          review.kind === "replace" &&
          review.saveRequiresConfirmation === true,
      );
      if (!currentBinding()) return;
      saved(result);
      close();
    } catch (error) {
      if (currentBinding()) setError(String(error));
    } finally {
      if (current === sequence.current) {
        running.current = false;
        setWorking(false);
        setBusy(false);
      }
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="file-action-dialog"
      aria-label="Save as"
      onCancel={(event) => {
        event.preventDefault();
        if (!running.current) close();
      }}
    >
      <div className={`file-action-emblem ${review ? "destructive" : ""}`}>
        <FilePenLine size={23} />
      </div>
      <p className="eyebrow">REMOTE FILES</p>
      <h2>{review ? "Replace existing file?" : "Save as"}</h2>
      <p className="file-action-description">
        {review
          ? review.kind === "replace" && review.saveRequiresConfirmation
            ? nonAtomicSaveWarning
            : "This file already exists. Replacing it saves your draft over its current contents. Other open drafts will be kept."
          : "Choose an existing remote folder and a file name. If a file already exists, you can review it before replacing it."}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {review?.kind === "replace" ? (
          <div className="file-action-target">
            <strong>{review.name}</strong>
            <br />
            {review.path}
          </div>
        ) : (
          <>
            <label>
              Remote folder
              <input
                aria-label="Destination folder"
                value={parent}
                disabled={working}
                onChange={(event) => setParent(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              Name
              <input
                ref={nameField}
                aria-label="File name"
                value={name}
                disabled={working}
                onChange={(event) => setName(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          </>
        )}
        {!connected && (
          <div className="inline-error" role="alert">
            Reconnect this host before saving. Your draft is kept.
          </div>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
            {review && (
              <p>
                Go back to review the destination again, or cancel to keep
                editing your draft.
              </p>
            )}
          </div>
        )}
        <div className="file-action-buttons">
          <button type="button" disabled={working} onClick={close}>
            Cancel
          </button>
          {review && (
            <button
              type="button"
              ref={backButton}
              disabled={working}
              onClick={() => {
                setReview(null);
                setError("");
              }}
            >
              Back
            </button>
          )}
          <button
            className={review ? "danger-button" : "file-action-submit"}
            disabled={
              working ||
              !connected ||
              !name.trim() ||
              !parent.trim() ||
              (!!review && !canReplace)
            }
          >
            {working ? (
              <>
                <LoaderCircle size={14} className="spin" /> Saving…
              </>
            ) : review ? (
              "Replace file"
            ) : (
              "Save"
            )}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
