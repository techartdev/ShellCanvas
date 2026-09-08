# Core completion work

User-authorized overnight goal, started 2026-09-08. The goal remains active across checkpoints. This list does not replace the wider backlog or claim the base is complete.

## Priorities and acceptance

1. **Files menus and clipboard:** contextual open/preview/navigation, explicit copy name/path/text, clipboard path navigation, keyboard access and clear error feedback. Browser fixtures use fake clipboard contents; OS clipboard checks remain separate.
2. **Multiple app instances:** separate terminal channels and Files navigation, unique instance identities, minimize/close isolation, dock instance switching, window and desktop menus. Switching hosts preserves all their instances.
3. **Text editor:** open remote UTF-8 text, edit and save through provider services, conflict detection, bounded file size, loading/error states, undo/search/wrap, and unsaved-change handling for window/workspace closure. No silent overwrite after remote changes.
4. **Settings:** persisted interface preferences, terminal/editor/file preferences, and usable host profile/settings entry points. Remote administrative changes must use provider-supported operations with explicit UI actions; do not invent universal shell commands for arbitrary devices.
5. **Everyday files:** upload/download, progress/cancellation, new folders, rename and deliberate deletion with failure/overwrite handling. Validate writes only in a designated disposable test directory.
6. **Integration quality:** workspace/window keyboard use, consistent menus, empty/error states, reconnect behavior, native build and relevant tests. Keep the approved visual direction and a bounded dependency footprint.

Additional protocols are optional until these core workflows work well. Connection-neutral service boundaries remain required; implement another protocol only when it proves the design and can be tested. AI, monetization, external-extension trust/runtime, credential-vault policy and other discussion-dependent decisions remain deferred.

## Evidence and outstanding work

- Window menus now expose keyboard move/resize and left/right tiling. Titlebars support F6 cycling and Shift+F10 menus. Browser geometry, cancellation, restore, edge bounds and desktop/tablet transition checks passed; see [window controls](window-management.md). Native keyboard and layout persistence checks remain separate.

- Host details now renders provider-defined remote settings with individual availability, proposals, review/apply and conflict/uncertain-outcome handling. Linux hostname/timezone commands have controlled tests; live read-only inspection and desktop/tablet UI checks passed. Actual systemd mutations still require a disposable host. See [remote settings](remote-settings.md).

- Regular-file upload/download now has native pickers, a bounded streaming broker, per-window queues, progress, cancellation and no-clobber publication. Automated cleanup/ownership/late-outcome checks, browser queue interactions, a disposable live SFTP probe and an 8 MiB Windows native dialog round trip passed. See [transfers](transfers.md). Resume, recursive transfers, permission-denied and physical-network interruption checks remain.

- Files and Editor now consume provider-owned names, parents, home and roots without parsing paths. File contracts were extracted from the SSH implementation. Drive/opaque UI fixtures and a read-only Linux regression passed; see [filesystem contracts](filesystem-contract.md). This prepares transfers and future providers; it does not add a production connector.

- Files keyboard menu copied the exact selected path using the fake clipboard and opened a folder in an independent second Files window. Clipboard-path navigation changed only that second window.
- Two Terminal windows accepted separate input; closing the second left the first usable with its own buffer. Window element order remains stable while stacking changes, avoiding lost clicks on focus.
- Desktop, dock, window titlebar and Files share the same menu component. Dock/window menus expose creation and existing instances; Files also exposes a touch-accessible actions button.
- Editor now opens/saves existing remote text, with undo/redo, find, wrapping, clipboard and unsaved-close guards. Browser conflict/loss checks retain drafts; the live disposable-file probe passed save/readback, basic metadata, conflicts, bounds and cleanup. See [editor behavior and limits](text-editor.md).
- Desktop, terminal, editor and Files preferences now persist and apply across open windows. Host entries open the selected connection settings. Browser persistence, reset, draft preservation and shell continuity checks passed; see [settings behavior](settings.md).
- Files now creates folders, renames items and deliberately deletes files/links/empty folders. Editor Save As creates a new file without overwriting an existing name. Browser checks passed including refresh across two Files windows; a disposable live-host probe verified creation, rename, stale checks, symlink isolation and cleanup. See [file-action behavior and limits](file-actions.md).
- Explicit reconnect now preserves app instances, folder paths and editor drafts, while starting new shells. Slow attempts can be canceled and late results are disconnected; unsupported capabilities preserve accessible local work. Browser, workspace and native handshake-cancellation checks passed; see [connection recovery](connection-recovery.md).
- Windows native walkthrough passed Unicode/multiline clipboard copy and paste between independent editor drafts, canceled app quit preserving both drafts, and confirmed discard-and-quit. The Dusk preference survived a full process restart; the original Fjord preference was restored afterward. No remote files or administrative settings were changed in this walkthrough.
- Broader file operations/recursive deletion and final integration audit remain open. Remote settings writes on a disposable systemd host, write permissions, physical-network interruption and interrupted-operation outcomes still need walkthroughs. The goal is not complete at this checkpoint.
