# Desktop and host preferences

Open **Desktop settings** from the dock or the desktop context menu. Preferences apply immediately across existing app windows and new ones.

- **Desktop:** three landscapes, system/12/24-hour clock, seconds and reduced motion. The clock uses the local device timezone. OS reduced-motion styling remains effective regardless of the app switch.
- **Terminal:** font size, cursor shape/blinking, and scrollback limit. Existing xterm instances update and refit without reopening their remote shell. Reducing scrollback discards older local output.
- **Text editor:** font size, word wrap, line numbers and Tab indentation (two/four spaces or a tab). Changing these preserves file contents, undo history and unsaved drafts. Line numbers are shown only with wrapping off; changing indentation affects subsequent Tab input.
- **Files:** hidden dotfiles, folders first, name/date/size ordering, descending order and compact rows. Sorting does not mutate provider data. Unknown dates stay last. Name/Modified/Size headers select a sort key; activating the selected header reverses direction. Choosing a different key retains the current direction. **Sort and view…** in file/folder context menus exposes checked sort/order choices, folders first, hidden files and compact rows. These are the same saved preferences as Settings and apply across open Files windows. Selection, folder location and filters are retained; no remote read or mutation is needed. The sort menu remains usable when a column is hidden in a compact layout.
- **Hosts:** saved/imported entries open the selected connection profile. Editing a profile does not alter a live connection. Current-host details and its **Remote settings** tab are accessible here. The initial Linux provider exposes static hostname and timezone controls when supported, with review and conflict checks; see [remote settings](remote-settings.md). Network/service administration remains unimplemented.

## Persistence and boundaries

Non-secret preferences use the versioned `shellcanvas.preferences` entry in local WebView storage. Browser preview and native WebView storage are separate. The previous ShellCanvas/SSHDesktop wallpaper key is read for migration when no new preference entry exists. Passwords, passphrases, host records and editor buffers are not stored here. Saved hosts retain the native, separately versioned `hosts.json` store.

Values are validated on read. Malformed JSON or an unsupported schema version is preserved; Settings reports the problem and requires an explicit **Restore defaults** before replacing it. A failed write applies changes in memory and reports that they were not saved. Restore defaults has a confirmation step and resets only desktop preferences, without deleting host profiles or closing windows. Tabs on the same origin receive storage updates; concurrent edits use the storage's last-write behavior.

Settings is a modal dialog with browser-managed focus containment, Escape dismissal and focus restoration. It uses the existing desktop palette. Remote provider settings live in Host details; a public namespaced extension settings API remains separate backlog work.

## Verification

- Direct sorting controls: the browser `sort.html` fixture passed header selection, Enter reversal, arrow/Enter menu selection, grouped checked states, unknown-date ordering, selection retention, visibility/density changes, two-window synchronization and fresh-page persistence. Its provider-read counter stayed unchanged during view changes. Ordinary window menus and right tiling also passed after shared menu grouping was added. Original preferences were restored through the UI afterward. All 72 frontend tests and the standard Windows debug build passed; native interaction with these new controls remains a separate walkthrough.
- Files now uses its own width for compact layout. A small floating window collapses the sidebar, keeps the location field and name/size columns visible, and hides the Modified column while a neighboring larger window retains all columns. Browser keyboard-resize checks verified both layouts simultaneously and sorting by the hidden Modified column through the menu. This fixes clipping that viewport-only media queries missed.

- Unit tests cover legacy migration, fresh-store persistence, invalid field bounds, corrupt/future data preservation, explicit reset, storage failure and subscribers. File view tests cover natural ordering, hidden filters, folder grouping, unknown dates and immutable input.
- Browser fixture: wallpaper/clock, 18 px terminal text and cursor update without additional shell-open events; file visibility/order/30 px rows update without folder navigation; editor text size/wrapping and four-space Tab preserve a draft.
- Fresh browser page retained preferences. Reset cancellation retained the chosen wallpaper; confirmed reset restored default text size, wallpaper and hidden files. Escape closed Settings and returned focus to the dock button.
- Host selection opened the corresponding connection form. The settings UI was visually inspected at a desktop viewport. Narrow-view/native persistence walkthroughs remain part of the integration audit.

The fixture is `tests/fixtures/workspaces.html` under the development server. It has fake host, terminal, filesystem and clipboard services and does not execute remote commands.
