# Saved host workflow

Open Connections and use **Your hosts** to choose a profile or create a new one. The picker separates profiles saved on this device from entries imported from SSH config. Both groups sort naturally by name, and each row shows username, host and port to distinguish similar names.

Search matches words across name, address, username, port and source ("saved" or "SSH config"), without changing the connection form. Arrow keys navigate matching entries; Ctrl+Home/End jumps to the first/last result. Enter selects the highlighted result, Escape closes only the picker, and Tab continues to New host and then the connection form. An empty search result never submits a connection. Selection fills the form; **Open workspace** remains a separate action.

Editing a saved profile and choosing **Update saved host** updates that entry. Saving an imported SSH-config entry creates a separate ShellCanvas copy. Removing a saved copy uses an explicit confirmation and does not remove its imported source. Search text and picker state are not persisted.

The existing versioned native JSON store and atomic/cross-process save behavior are unchanged. Profile storage excludes passwords and passphrases. Reconnect keeps the selected endpoint fixed and does not offer the host picker.

## Older SSH hosts

**Allow legacy SSH compatibility** is an explicit per-host option, disabled by default. It is saved with the profile and retained for reconnects. Existing profiles and SSH-config imports keep modern defaults. Turning the option off and saving removes the exception. The persisted field remains `allowLegacyMac` for compatibility with existing profiles; previously enabled profiles now receive the compatibility behavior described below.

This option appends HMAC-SHA1 after modern MAC algorithms and permits 2048-bit Diffie–Hellman group exchange while keeping the larger preferred group size. Exchange algorithm, cipher and host-key preferences remain unchanged: it does not enable SHA1 key exchange, group1, CBC ciphers or MD5, or bypass host-key verification.

For RSA user keys, advertised SHA2 signatures stay preferred. Without a signature-algorithm advertisement, SHA256 is attempted first; an ordinary rejection allows one RSA/SHA1 retry only with this option enabled. A host advertising only RSA/SHA1 requires the option. Transport failures and partial authentication never trigger this retry. Non-RSA keys are unaffected.

The connection dialog and Host details show the enabled exceptions, not a claim that those algorithms were negotiated. Built-in SSH sources in mixed workspaces expose the same option. This accommodates older MikroTik SSH servers offering HMAC-SHA1, a 2048-bit SHA256 exchange group, and legacy RSA user authentication. It does not add RouterOS-specific desktop capabilities: services such as SFTP must still be supported by the device.

For a bounded read-only authentication and interactive-terminal check against a trusted appliance, use `cargo run -p shellcanvas-core --example terminal_probe -- HOST USER KEY_PATH --legacy`. It opens and closes a PTY without sending commands or printing remote output. Omit `--legacy` to check modern defaults.

## Verification

The development fixture `/tests/fixtures/hosts.html?many=1` starts with 40 saved and 40 imported profiles. Browser checks passed multiword/case-insensitive username/port/host search, both source groups, keyboard scrolling to late entries, Enter selection, no-match Enter, Escape without closing the connection dialog, and Tab dismissal. Saving an imported copy and removing only that copy preserved the source and returned the count to 80. Connection submission count stayed zero. Desktop and 390-pixel narrow layouts were visually checked. These use fixture profiles; native storage persistence remains covered by the existing Rust tests and earlier native checks.

Custom groups/tags, history, import/export files and connector-specific profile schemas remain separate backlog items.
