# Desktop clock

The top bar displays the active workspace's remote time when available. Both the date and time use the remote clock and its current UTC offset. The desktop's 12/24-hour and seconds preferences still apply. Hover over the clock to see its source and offset.

Built-in SSH connections to detected Linux, macOS, Windows, and MikroTik RouterOS hosts supply a fixed, read-only clock probe over an independent command channel. ShellCanvas never types the probe into an interactive terminal. In mixed workspaces, the clock follows the selected console connection; it does not silently switch to another device providing files.

RouterOS uses `/system clock print`, including the device's date, time and `gmt-offset`. The parser supports older `sep/12/2026` dates and newer ISO dates. Its explicit UTC offset determines the display rather than the client's timezone. RouterOS 6.49.19 detection and clock sampling were verified on a live device; the newer date format has parser coverage.

The client samples on workspace activation, every minute, and when the app regains focus or visibility. Between samples it advances the remote timestamp using monotonic elapsed time, with an approximate half-round-trip latency correction. This is a desktop display, not a precision time synchronization service. Timezone/DST and remote clock changes appear after the next successful sample.

Disconnected, unsupported, failed, or pending readings use the client clock with a visible **Local** label. Samples expire after two minutes without a refresh. Switching hosts or replacing a connection invalidates the previous clock; late replies from another workspace are discarded. A local workspace also shows **Local**.

For containers such as Home Assistant's SSH add-on, this reflects the clock and timezone exposed inside the connected environment. Runtime adapters without a clock reader use the labelled fallback.
