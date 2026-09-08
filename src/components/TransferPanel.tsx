// SPDX-License-Identifier: MPL-2.0
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  X,
  LoaderCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Copy,
} from "lucide-react";
import { useState } from "react";
import {
  pendingTransfer,
  type TransferQueue,
  type TransferRow,
} from "../transfer-queue";
import "./TransferPanel.css";
function bytes(value: number) {
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)} GB`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}
export function TransferPanel({
  rows,
  queue,
}: {
  rows: TransferRow[];
  queue: TransferQueue;
}) {
  const [expanded, setExpanded] = useState(true);
  const failures = rows.filter(
    (row) => row.status === "failed" || row.status === "cancel-failed",
  ).length;
  const visibleRows = [
    ...rows.filter(pendingTransfer),
    ...rows.filter((row) => !pendingTransfer(row)).reverse(),
  ];
  return (
    <section
      className={`transfer-panel ${expanded ? "" : "collapsed"}`}
      aria-label="File transfers"
    >
      <header>
        <button
          className="transfer-toggle"
          aria-label={expanded ? "Hide transfers" : "Show transfers"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          <strong>Transfers</strong>
          <span>
            {rows.filter(pendingTransfer).length} active
            {failures ? ` · ${failures} failed` : ""}
          </span>
        </button>
        <button
          disabled={!rows.some((row) => !pendingTransfer(row))}
          onClick={() => queue.clearFinished()}
        >
          Clear finished
        </button>
      </header>
      <div className="transfer-list" hidden={!expanded}>
        {visibleRows.map((row) => {
          const Icon =
            row.direction === "copy"
              ? Copy
              : row.direction === "upload"
                ? ArrowUpFromLine
                : ArrowDownToLine;
          const label =
            row.status === "running"
              ? row.phase === "preparing"
                ? `Scanning${row.items ? ` · ${row.items.toLocaleString()} items` : ""}…`
                : row.phase === "finishing"
                  ? "Finishing…"
                  : row.direction === "copy"
                    ? "Copying…"
                    : "Transferring…"
              : {
                  queued: "Queued",
                  canceling: "Canceling…",
                  "cancel-failed": "Cancel failed",
                  completed: "Completed",
                  canceled: "Canceled",
                  failed: "Failed",
                }[row.status];
          return (
            <div key={row.id} className={`transfer-row ${row.status}`}>
              <Icon size={16} />
              <div className="transfer-detail">
                <div>
                  <strong title={row.name}>{row.name}</strong>
                  <span>{label}</span>
                </div>
                <progress
                  aria-label={`${row.direction === "copy" ? "Copy" : row.direction === "upload" ? "Upload" : "Download"} ${row.name}`}
                  max={Math.max(1, row.total)}
                  value={
                    row.status === "running" && row.phase === "preparing"
                      ? undefined
                      : row.status === "completed"
                        ? Math.max(1, row.total)
                        : row.bytes
                  }
                />
                <small>
                  {row.direction === "copy"
                    ? "On this host"
                    : row.direction === "upload"
                      ? "To host"
                      : "To this device"}{" "}
                  · {bytes(row.bytes)}
                  {row.total > 0 ? ` / ${bytes(row.total)}` : ""}
                </small>
                {row.message && (
                  <p role={row.status === "failed" ? "alert" : undefined}>
                    {row.message}
                  </p>
                )}
              </div>
              {pendingTransfer(row) ? (
                <button
                  aria-label={`Cancel ${row.name}`}
                  title="Cancel transfer"
                  disabled={
                    row.status === "canceling" || row.phase === "finishing"
                  }
                  onClick={() => void queue.cancel(row.id)}
                >
                  {row.status === "canceling" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <X size={14} />
                  )}
                </button>
              ) : row.status === "completed" ? (
                <Check className="transfer-success" size={16} />
              ) : row.status === "failed" ? (
                <AlertCircle size={16} />
              ) : (
                <X size={14} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
