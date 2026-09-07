// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Circle, RotateCcw } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { AppContext, TerminalSession } from "../sdk";
export function Terminal({
  session,
  services,
  preview,
  reportError,
}: AppContext) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Opening shell…");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!container.current || !session) return;
    let disposed = false;
    let closed = false;
    let remote: TerminalSession | undefined;
    const terminal = new XTerminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      lineHeight: 1.35,
      scrollback: 3000,
      allowProposedApi: false,
      theme: {
        background: "#111b26",
        foreground: "#d4dfe6",
        cursor: "#a3ddc5",
        selectionBackground: "#385364",
        black: "#182430",
        red: "#e59191",
        green: "#8fd1ad",
        yellow: "#e7c993",
        blue: "#8cb8d9",
        magenta: "#c8a5d5",
        cyan: "#8ccacb",
        white: "#e2e9ed",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    const observer = new ResizeObserver(() => {
      if (container.current?.clientWidth) fit.fit();
    });
    observer.observe(container.current);
    fit.fit();
    setStatus("Opening shell…");
    const input = terminal.onData((data) => {
      void remote?.write(data).catch((e) => {
        if (!disposed) setStatus(`Input failed: ${e}`);
      });
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      void remote?.resize(cols, rows).catch((e) => {
        if (!disposed) setStatus(`Resize failed: ${e}`);
      });
    });
    void services
      .terminal(session.id, terminal.cols, terminal.rows, (event) => {
        if (disposed) return;
        if (event.type === "output") terminal.write(new Uint8Array(event.data));
        else if (event.type === "closed") {
          closed = true;
          setStatus("Shell closed");
        } else {
          closed = true;
          setStatus(event.data);
        }
      })
      .then(async (handle) => {
        if (disposed) {
          await handle.close();
          return;
        }
        remote = handle;
        if (!closed)
          setStatus(
            preview
              ? "Design preview · no commands executed"
              : "Live SSH shell",
          );
        await handle.resize(terminal.cols, terminal.rows);
      })
      .catch((e) => {
        if (!disposed) setStatus(String(e));
      });
    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
      void remote?.close().catch((error) => reportError(String(error)));
    };
  }, [session?.id, services, attempt, reportError]);
  return (
    <div className="terminal-app">
      <div className="terminal-tabs">
        <span>
          <Circle size={7} fill="currentColor" /> {session?.info.hostname}{" "}
          <span className="terminal-tab-path">~</span>
        </span>
        <span>SSH</span>
      </div>
      <div className="terminal-container" ref={container} />
      <footer className="terminal-footer">
        <span title={status}>{status}</span>
        <button
          onClick={() => setAttempt(attempt + 1)}
          title="Open a new shell"
        >
          <RotateCcw size={12} /> New shell
        </button>
      </footer>
    </div>
  );
}
