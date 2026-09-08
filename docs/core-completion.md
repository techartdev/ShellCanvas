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

- Files keyboard menu copied the exact selected path using the fake clipboard and opened a folder in an independent second Files window. Clipboard-path navigation changed only that second window.
- Two Terminal windows accepted separate input; closing the second left the first usable with its own buffer. Window element order remains stable while stacking changes, avoiding lost clicks on focus.
- Desktop, dock, window titlebar and Files share the same menu component. Dock/window menus expose creation and existing instances; Files also exposes a touch-accessible actions button.
- Editor now opens/saves existing remote text, with undo/redo, find, wrapping, clipboard and unsaved-close guards. Browser conflict/loss checks retain drafts; the live disposable-file probe passed save/readback, basic metadata, conflicts, bounds and cleanup. See [editor behavior and limits](text-editor.md).
- Settings expansion, transfers, file creation/rename/delete, Save As and final integration audit remain open. Native dirty-editor app quit still needs a walkthrough. The goal is not complete at this checkpoint.
