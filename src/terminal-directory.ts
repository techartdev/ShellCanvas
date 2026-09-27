// SPDX-License-Identifier: MPL-2.0
import { capabilityStatus, type Session, type TerminalDirectory } from "./sdk";

/** A file path is meaningful only in the console's own source namespace. */
export function terminalDirectoryFor(
  session: Session | null,
  path: string,
): TerminalDirectory | undefined {
  if (
    !session ||
    !path ||
    !["linux", "macos", "windows"].includes(session.info.provider)
  )
    return;
  const files = capabilityStatus(session, "files.read");
  const terminal = capabilityStatus(session, "terminal");
  const source = files.source;
  const consoleSource = terminal.source;
  if (
    files.state !== "available" ||
    terminal.state !== "available" ||
    !source ||
    !consoleSource ||
    source.adapter !== "ssh" ||
    source.adapter !== consoleSource.adapter ||
    source.instance !== consoleSource.instance ||
    source.generation !== consoleSource.generation
  )
    return;
  return { path, source: { ...source } };
}
