// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./ConfirmDialog.css";
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirm,
  cancel,
  disabled = false,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  confirm(): void;
  cancel(): void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      previous?.isConnected && previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <p className="eyebrow">YOUR WORK</p>
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="confirm-actions">
        <button autoFocus onClick={cancel}>
          Keep working
        </button>
        <button disabled={disabled} className="danger-button" onClick={confirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
