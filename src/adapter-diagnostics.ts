// SPDX-License-Identifier: MPL-2.0
import type { ConnectionIdentity } from "./sdk";
export const diagnosticLabels = {
  preparationFailed: "Package preparation failed",
  preparationCanceled: "Package preparation canceled",
  launchRequested: "Starting adapter",
  spawned: "Adapter process started",
  ready: "Services ready",
  initializationFailed: "Startup failed",
  initializationCanceled: "Startup canceled",
  requestDispatched: "Request sent",
  requestSucceeded: "Request completed",
  requestFailed: "Request failed",
  requestCanceled: "Request canceled",
  requestRejected: "Request refused before dispatch",
  requestDeadline: "Request timed out",
  lateReply: "Late reply discarded",
  closeRequested: "Connection closing",
  processExited: "Adapter process exited",
  inputFailure: "Adapter input failed or stalled",
  outputFailure: "Adapter output ended or was invalid",
  invalidResponse: "Invalid response received",
  unknownReply: "Unexpected response identity",
  inputBackpressure: "Adapter input queue unavailable",
  identityExhausted: "Request identity space exhausted",
  cleanupConfirmed: "Process cleanup confirmed",
  cleanupUnconfirmed: "Process cleanup unconfirmed",
} as const;
export interface DiagnosticEvent {
  sequence: number;
  elapsedMs: number;
  kind: keyof typeof diagnosticLabels;
  requestId: number | null;
  code:
    | "invalid"
    | "closed"
    | "aborted"
    | "denied"
    | "unavailable"
    | "busy"
    | "failed"
    | "deadline"
    | null;
}
export interface ConnectionDiagnostics {
  schemaVersion: 1;
  status: "preparing" | "starting" | "connected" | "closed" | "failed";
  connection: ConnectionIdentity;
  attempt: number;
  events: DiagnosticEvent[];
  discardedEvents: number;
}
