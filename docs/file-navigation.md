# Files navigation after changes

Files windows follow confirmed renames and moves initiated in their own workspace. The provider returns explicit location mappings for the open folder, its parent/home/roots, Back history, selected item and preview. Apps never infer relationships from a slash, prefix, drive name or object ID.

Mappings are applied before the shared refresh notification. A window inside a renamed folder or one of its descendants keeps following that folder. Back history follows the same mappings and is bounded to 50 entries per window. A failed Back request keeps its entry so the user can retry. Up uses the new provider-supplied parent.

Background refreshes preserve filters and an address the user is still typing. Selections follow when the mapped item is still present in the refreshed folder; moving it elsewhere clears the selection. Completed previews retain their text and get the new name/path, including Copy file path. Ordinary content-change notifications still close previews so a prior snapshot is not presented as freshly read content.

At the beginning of a relocation, participating windows invalidate pending directory/preview requests and pause navigation until its result arrives. Older responses cannot restore obsolete paths. An unfinished preview closes; the confirmed directory is refreshed afterward. Failed or uncertain relocation results do not update identities. Other hosts and windows opened after the move started do not adopt its mappings. Relocations wait for active file pickers/transfers and editor operations/dialogs before starting; normal browsing remains available during transfers.

Tracking is bounded to 256 distinct locations across participating windows. Renames/moves performed in a terminal, another session or an external tool are not tracked. History/layout remains in memory. This does not add remote filesystem watching, cross-host moves or another production filesystem provider.

## Verification

The 2026-09-08 checkpoint passed 47 frontend tests, the production frontend build and the standard Windows debug build. Navigation tests cover opaque identities, folder/parent/history/place mappings, preview/selection mapping, unsubmitted address preservation and refusal to infer prefix relationships. Broker tests verify mapping precedes refresh and retain failure/session-loss isolation.

The two-window browser walkthrough passed ancestor rename, folder move, Back to a mapped location, preview preservation and copied path, preserved filter/selection/typed address, and failed Back followed by a successful retry. The delayed-list fixture recorded the old response arriving after rename; the window retained the new path. The opaque fixture retained a preview across `object@93?kind=text` becoming `moved@1`, copied that exact new ID and cleared the now-absent selection. These use synthetic data and clipboard; native GUI/OS clipboard validation remains separate. Rust relocation and live disposable SFTP mapping checks were completed in the preceding editor checkpoint and were not rerun for this frontend-only change.
