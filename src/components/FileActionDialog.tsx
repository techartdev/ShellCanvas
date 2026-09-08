// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, LoaderCircle, FilePenLine, Trash2 } from "lucide-react";
import "./FileActionDialog.css";
export function FileActionDialog({
  title,
  description,
  initialName = "",
  initialParent,
  readOnlyName = false,
  confirmLabel,
  destructive = false,
  execute,
  close,
  setBusy,
  disabled = false,
}: {
  title: string;
  description: string;
  initialName?: string;
  initialParent?: string;
  readOnlyName?: boolean;
  confirmLabel: string;
  destructive?: boolean;
  disabled?: boolean;
  execute(name: string, parent: string): Promise<void>;
  close(): void;
  setBusy(busy: boolean): void;
}) {
  const [name, setName] = useState(initialName);
  const [parent, setParent] = useState(initialParent ?? "");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    if (!readOnlyName) {
      input.current?.focus();
      input.current?.select();
    }
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  async function submit() {
    if (working || disabled) return;
    if (
      !readOnlyName &&
      (!name.trim() ||
        [".", ".."].includes(name) ||
        /[\/\x00-\x1f\x7f]/.test(name) ||
        new TextEncoder().encode(name).length > 255)
    ) {
      setError(
        "Enter one name without slashes or control characters, up to 255 UTF-8 bytes.",
      );
      return;
    }
    if (initialParent !== undefined && !parent.trim()) {
      setError("Choose an existing remote folder.");
      return;
    }
    setWorking(true);
    setBusy(true);
    setError("");
    try {
      await execute(name, parent);
      close();
    } catch (error) {
      setError(String(error));
    } finally {
      setWorking(false);
      setBusy(false);
    }
  }
  const Icon = destructive
    ? Trash2
    : initialParent === undefined
      ? Folder
      : FilePenLine;
  return createPortal(
    <dialog
      className="file-action-dialog"
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!working) close();
      }}
    >
      <div className={`file-action-emblem ${destructive ? "destructive" : ""}`}>
        <Icon size={23} />
      </div>
      <p className="eyebrow">REMOTE FILES</p>
      <h2>{title}</h2>
      <p className="file-action-description">{description}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {initialParent !== undefined && (
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
        )}
        {readOnlyName ? (
          <div className="file-action-target">{name}</div>
        ) : (
          <label>
            Name
            <input
              ref={input}
              aria-label="File or folder name"
              value={name}
              disabled={working}
              onChange={(event) => setName(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="file-action-buttons">
          <button
            type="button"
            autoFocus={readOnlyName}
            disabled={working}
            onClick={close}
          >
            Cancel
          </button>
          <button
            className={destructive ? "danger-button" : "file-action-submit"}
            disabled={working || disabled || !name.trim()}
          >
            {working ? (
              <>
                <LoaderCircle size={14} className="spin" /> Working…
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
