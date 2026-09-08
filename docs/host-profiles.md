# Saved host workflow

Open Connections and use **Your hosts** to choose a profile or create a new one. The picker separates profiles saved on this device from entries imported from SSH config. Both groups sort naturally by name, and each row shows username, host and port to distinguish similar names.

Search matches words across name, address, username, port and source ("saved" or "SSH config"), without changing the connection form. Arrow keys navigate matching entries; Ctrl+Home/End jumps to the first/last result. Enter selects the highlighted result, Escape closes only the picker, and Tab continues to New host and then the connection form. An empty search result never submits a connection. Selection fills the form; **Open workspace** remains a separate action.

Editing a saved profile and choosing **Update saved host** updates that entry. Saving an imported SSH-config entry creates a separate ShellCanvas copy. Removing a saved copy uses an explicit confirmation and does not remove its imported source. Search text and picker state are not persisted.

The existing versioned native JSON store and atomic/cross-process save behavior are unchanged. Profile storage excludes passwords and passphrases. Reconnect keeps the selected endpoint fixed and does not offer the host picker.

## Verification

The development fixture `/tests/fixtures/hosts.html?many=1` starts with 40 saved and 40 imported profiles. Browser checks passed multiword/case-insensitive username/port/host search, both source groups, keyboard scrolling to late entries, Enter selection, no-match Enter, Escape without closing the connection dialog, and Tab dismissal. Saving an imported copy and removing only that copy preserved the source and returned the count to 80. Connection submission count stayed zero. Desktop and 390-pixel narrow layouts were visually checked. These use fixture profiles; native storage persistence remains covered by the existing Rust tests and earlier native checks.

Custom groups/tags, history, import/export files and connector-specific profile schemas remain separate backlog items.
