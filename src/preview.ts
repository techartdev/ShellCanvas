// SPDX-License-Identifier: MPL-2.0
// Explicitly synthetic data for browser-only visual development. Never used by
// the native client or as a fallback for a failed real connection.
import type { Directory, HostServices, Session } from "./sdk";
export const previewSession: Session = {
  id: 0,
  info: {
    provider: "linux",
    system: "Linux · sample host",
    hostname: "atlas",
    home: "/home/demo",
    capabilities: ["terminal", "files.read"],
    notices: [],
  },
};
const names = [
  "Documents",
  "Projects",
  "Backups",
  ".config",
  "welcome.md",
  "notes.txt",
  "compose.yaml",
];
function directory(path: string): Directory {
  const location = path === "." ? "/home/demo" : path;
  return {
    path: location,
    entries: names.map((name, i) => ({
      name,
      path: `${location === "/" ? "" : location}/${name}`,
      kind: i < 4 ? "directory" : "file",
      size: i < 4 ? 4096 : 240 + i * 72,
      modified: 1788825600,
    })),
  };
}
export const previewServices: HostServices = {
  profiles: async () => [],
  saveProfile: async () => {
    throw new Error("Save hosts in the native app.");
  },
  removeProfile: async () => {
    throw new Error("Manage saved hosts in the native app.");
  },
  connect: async () => {
    throw new Error("Open the native desktop app to connect over SSH.");
  },
  disconnect: async () => {},
  alive: async () => true,
  readText: async (_, path) => ({
    path,
    text: `# ${path.split("/").pop()}\n\nSample document. No remote file is connected.\n`,
    revision: "preview",
    writable: false,
  }),
  saveText: async () => {
    throw new Error("Preview documents cannot be saved to a remote host.");
  },
  list: async (_, path) => directory(path),
  preview: async (_, path) =>
    `# ${path.split("/").pop()}\n\nThis is sample content in the design preview.\nNo remote host is connected, and no files are being read.\n\nOpen the native app to explore your own host.\n`,
  terminal: async (_, __, ___, onEvent) => {
    const output = (text: string) =>
      onEvent({
        type: "output",
        data: Array.from(new TextEncoder().encode(text)),
      });
    output(
      "\x1b[38;2;115;205;173m  ShellCanvas\x1b[0m  /  design preview\r\n\r\n  Your remote workspace, one connection away.\r\n  \x1b[38;2;137;153;166mSample terminal • no commands are executed\x1b[0m\r\n\r\n\x1b[38;2;115;205;173mdemo@atlas\x1b[0m \x1b[38;2;153;183;210m~\x1b[0m $ ",
    );
    return {
      write: async (text) => {
        if (text.includes("\r"))
          output(
            "\r\nPreview only. Connect in the native app to run commands.\r\n\x1b[38;2;115;205;173mdemo@atlas\x1b[0m ~ $ ",
          );
      },
      resize: async () => {},
      close: async () => {},
    };
  },
};
