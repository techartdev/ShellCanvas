// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Files } from "lucide-react";
import { showModal } from "../dialog-compat";
import type { TransferConflictReview } from "../sdk";
import type { ConflictDecision } from "../transfer-queue";
import "./FileActionDialog.css";

export function TransferConflictDialog({
  conflict,
  remaining,
  decide,
}: {
  conflict: TransferConflictReview["conflicts"][number];
  remaining: number;
  decide(decision: ConflictDecision): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    showModal(dialog.current);
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const folder = conflict.sourceKind === "directory";
  return createPortal(
    <dialog
      ref={dialog}
      className="file-action-dialog transfer-conflict-dialog"
      aria-label="File already exists"
      onCancel={(event) => {
        event.preventDefault();
        decide("cancel");
      }}
    >
      <div className="file-action-emblem">
        <Files size={23} />
      </div>
      <p className="eyebrow">REMOTE FILES</p>
      <h2>{folder ? "Folder already exists" : "File already exists"}</h2>
      <p className="file-action-description">
        <strong>{conflict.destination.name}</strong> already exists on the host.
        {folder
          ? " Merge the folders and replace matching files? Files found only in the destination will stay."
          : " Replace the existing file with the copied file?"}{" "}
        There is no undo.
      </p>
      <p className="file-action-target">{conflict.destination.path}</p>
      {remaining > 1 && (
        <p className="file-action-description">
          {remaining - 1} more name {remaining === 2 ? "conflict" : "conflicts"}{" "}
          in this transfer.
        </p>
      )}
      <div className="file-action-buttons">
        <button autoFocus onClick={() => decide("cancel")}>
          Cancel transfer
        </button>
        <button onClick={() => decide("replace")}>Yes, replace</button>
        {remaining > 1 && (
          <button
            className="danger-button"
            onClick={() => decide("replace-all")}
          >
            Yes to all
          </button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
