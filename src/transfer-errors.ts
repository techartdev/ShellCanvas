// SPDX-License-Identifier: MPL-2.0
/** Execution stopped before dispatch, but its owned native reservation remains.
 * Keep the ticket for cancellation only; never retry its execution. */
export class TransferCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferCleanupError";
  }
}
