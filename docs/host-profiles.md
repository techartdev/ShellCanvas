# Saved host workflow

Open Connections and use **Your hosts** to choose a profile or create a new one. The picker separates profiles saved on this device from entries imported from SSH config. Both groups sort naturally by name, and each row shows username, host and port to distinguish similar names.

Search matches words across name, address, username, port and source ("saved" or "SSH config"), without changing the connection form. Arrow keys navigate matching entries; Ctrl+Home/End jumps to the first/last result. Enter selects the highlighted result, Escape closes only the picker, and Tab continues to New host and then the connection form. An empty search result never submits a connection. Selection fills the form; **Open workspace** remains a separate action.

Editing a saved profile and choosing **Update saved host** updates that entry. Saving an imported SSH-config entry creates a separate ShellCanvas copy. Removing a saved copy uses an explicit confirmation and does not remove its imported source. Search text and picker state are not persisted.

The existing versioned native JSON store and atomic/cross-process save behavior are unchanged. Profile storage excludes passwords and passphrases. Reconnect keeps the selected endpoint fixed and does not offer the host picker.

## Older SSH hosts

**Allow legacy SSH MAC (HMAC-SHA1)** is an explicit per-host option, disabled by default. It is saved with the profile and retained for reconnects. Existing profiles and SSH-config imports keep modern defaults. Turning the option off and saving removes the exception.

This option appends HMAC-SHA1 after the modern MAC algorithms. It does not enable MD5, change cipher/key-exchange/host-key algorithms, or bypass host-key verification. The connection dialog shows a compatibility warning, and connected Host details records that legacy MAC support is enabled (not a claim that SHA1 was negotiated).

Use it for older devices that report **No common Mac algorithm** and offer `hmac-sha1`. It addresses that negotiation mismatch only; a device may have other unsupported authentication, algorithm, or service requirements. Built-in SSH sources in mixed workspaces expose the same option.

## Verification

The development fixture `/tests/fixtures/hosts.html?many=1` starts with 40 saved and 40 imported profiles. Browser checks passed multiword/case-insensitive username/port/host search, both source groups, keyboard scrolling to late entries, Enter selection, no-match Enter, Escape without closing the connection dialog, and Tab dismissal. Saving an imported copy and removing only that copy preserved the source and returned the count to 80. Connection submission count stayed zero. Desktop and 390-pixel narrow layouts were visually checked. These use fixture profiles; native storage persistence remains covered by the existing Rust tests and earlier native checks.

Custom groups/tags, history, import/export files and connector-specific profile schemas remain separate backlog items.
