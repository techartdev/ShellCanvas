// SPDX-License-Identifier: MPL-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Circle, RotateCcw } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { AppContext, TerminalSession } from "../sdk";
import { ContextMenu } from "../components/ContextMenu";
import { clipboard } from "../clipboard";
import { usePreferences } from "../preferences";
export function Terminal({
  session,
  services,
  preview,
  reportError,
  active = true,
  connected = true,
  unavailableReason,
}: AppContext) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<XTerminal | null>(null);
  const { values: preferences } = usePreferences();
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const refit = useRef<(() => void) | null>(null);
  useEffect(() => {
    const terminal = instance.current;
    if (!terminal) return;
    terminal.options.fontSize = preferences.terminalFontSize;
    terminal.options.cursorStyle = preferences.terminalCursor;
    terminal.options.cursorBlink = preferences.terminalBlink;
    terminal.options.scrollback = preferences.terminalScrollback;
    refit.current?.();
  }, [
    preferences.terminalFontSize,
    preferences.terminalCursor,
    preferences.terminalBlink,
    preferences.terminalScrollback,
  ]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => {
    if (!active) closeMenu();
  }, [active, closeMenu]);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Opening shell…");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (instance.current) instance.current.options.disableStdin = !connected;
    if (!connected) {
      setReady(false);
      setStatus(
        unavailableReason ||
          "Connection closed · reconnect the host to open a new shell",
      );
    }
  }, [connected, unavailableReason]);
  async function copy() {
    const text = instance.current?.getSelection();
    if (!text) return;
    try {
      await clipboard.writeText(text);
    } catch (error) {
      reportError(`Copy failed: ${error}`);
    }
  }
  async function paste() {
    const target = instance.current;
    if (!target || !ready) return;
    try {
      const text = await clipboard.readText();
      // Never paste into a replacement shell after an asynchronous clipboard read.
      if (instance.current !== target) return;
      target.paste(text);
      target.focus();
    } catch (error) {
      reportError(`Paste failed: ${error}`);
    }
  }
  const clipboardActions = useRef({ copy, paste });
  clipboardActions.current = { copy, paste };
  useEffect(() => {
    if (!container.current || !session || !connected) return;
    let disposed = false;
    let closed = false;
    let remote: TerminalSession | undefined;
    const terminal = new XTerminal({
      cursorBlink: preferencesRef.current.terminalBlink,
      cursorStyle: preferencesRef.current.terminalCursor,
      fontSize: preferencesRef.current.terminalFontSize,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      lineHeight: 1.35,
      scrollback: preferencesRef.current.terminalScrollback,
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
    instance.current = terminal;
    setReady(false);
    let frame = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          !disposed &&
          container.current?.clientWidth &&
          container.current.clientHeight
        )
          fit.fit();
      });
    };
    const observer = new ResizeObserver(scheduleFit);
    refit.current = scheduleFit;
    observer.observe(container.current);
    fit.fit();
    void document.fonts.ready.then(() => {
      if (!disposed) scheduleFit();
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        if (event.type === "keydown") {
          event.preventDefault();
          const rect = container.current!.getBoundingClientRect();
          setMenu({ x: rect.left + 24, y: rect.top + 24 });
        }
        return false;
      }
      const command = (event.ctrlKey && event.shiftKey) || event.metaKey;
      if (
        command &&
        !event.altKey &&
        ["c", "v"].includes(event.key.toLowerCase())
      ) {
        if (event.type === "keydown") {
          event.preventDefault();
          void (event.key.toLowerCase() === "c"
            ? clipboardActions.current.copy()
            : clipboardActions.current.paste());
        }
        return false;
      }
      return true; // Ctrl+C remains a remote interrupt.
    });
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
      .terminal(terminal.cols, terminal.rows, (event) => {
        if (disposed) return;
        if (event.type === "output") terminal.write(new Uint8Array(event.data));
        else if (event.type === "closed") {
          closed = true;
          setReady(false);
          setStatus("Shell closed");
        } else {
          closed = true;
          setReady(false);
          setStatus(event.data);
        }
      })
      .then(async (handle) => {
        if (disposed) {
          await handle.close();
          return;
        }
        remote = handle;
        setReady(!closed);
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
      instance.current = null;
      refit.current = null;
      cancelAnimationFrame(frame);
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
      <div
        className="terminal-container"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left + 24, y: rect.top + 24 });
          }
        }}
      >
        <div className="terminal-viewport" ref={container} />
      </div>
      {menu && (
        <ContextMenu
          label="Terminal actions"
          {...menu}
          close={closeMenu}
          actions={[
            {
              id: "copy",
              label: "Copy",
              shortcut: "Ctrl+Shift+C",
              disabled: !instance.current?.hasSelection(),
              run: () => {
                void copy();
              },
            },
            {
              id: "paste",
              label: "Paste",
              shortcut: "Ctrl+Shift+V",
              disabled: !ready,
              run: () => {
                void paste();
              },
            },
            {
              id: "select-all",
              label: "Select all",
              run: () => instance.current?.selectAll(),
            },
            {
              id: "clear",
              label: "Clear scrollback",
              run: () => instance.current?.clear(),
            },
            {
              id: "new-shell",
              label: "New shell",
              disabled: !connected,
              run: () => setAttempt((value) => value + 1),
            },
          ]}
        />
      )}
      <footer className="terminal-footer">
        <span title={status}>{status}</span>
        <button
          onClick={() => setAttempt(attempt + 1)}
          disabled={!connected}
          title="Open a new shell"
        >
          <RotateCcw size={12} /> New shell
        </button>
      </footer>
    </div>
  );
}
