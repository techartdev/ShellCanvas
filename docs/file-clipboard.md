# Cut and paste remote items

Files supports one pending cut per connected workspace. Select a file, folder or symlink and use **Cut** (Ctrl+X). Browse to a destination in the same or another Files window, then use **Paste here** (Ctrl+V). A folder's context menu also offers **Paste into folder**. The banner shows the item and its original location; **Cancel cut** or Escape outside editable fields clears it without contacting the host.

Cut only records the item. Paste calls the existing revision-checked, no-replacement move service. It moves the item with its name intact, including nonempty folders where the provider supports them. The source and destination listings refresh, and open editors/Files views follow the same provider relocation mappings as Move to folder. The clipboard survives closing the source Files window, but never crosses workspace/service bindings or survives disconnect, reconnect or application restart.

The file clipboard is separate from the OS text clipboard. Copy name/path/text and Go to clipboard path continue to use text. Pasting in an address, filter or editor remains text editing; pasting on the Files surface uses the pending remote item. Native Cut/Paste edit events and keyboard shortcuts both work, without interpreting external clipboard text as a remote move request.

Only one clipboard move can run at a time. While it runs, the item cannot be replaced or canceled. A failed move retains the original item/revision and displays the error; retry is always explicit. For an uncertain remote outcome, inspect the destination before retrying. The underlying SFTP revision is a metadata precondition, with the [same limitations as other file actions](file-actions.md); it is not a content hash or distributed lock. A confirmed rename/move of the cut item or its parent clears the cut because relocation mappings do not include a replacement revision. Confirmed deletion clears it too. External changes are checked by the provider on Paste and may require refreshing and cutting again.

Cut/Paste requires `files.move`. Source/destination tokens are opaque: the clipboard never constructs paths. Its two tracked locations count toward the existing 256-location relocation limit. Read-only sessions cannot gain move access through the clipboard. There is no remote copy/duplicate, multi-selection, cross-host transfer or persistent clipboard yet.

## Verification

- Seven clipboard tests cover shared immutable selections, exact opaque tokens and revisions, same-folder/self refusal, one-shot success, explicit retry after failure, duplicate/pending actions, capability checks, host isolation, disconnect and late outcomes, relocation invalidation and deletion outcomes. The full frontend suite passed 54 tests.
- The two-window browser fixture passed context-menu Cut, shared indicators, collision refusal with both original items intact, successful retry into an empty folder, both listings refreshing, shortcut/edit-event cut and paste, ordinary address-field text paste, Escape cancellation and pasting after the source window closed.
- The opaque fixture passed `object@93?kind=text` into `node@19%2Fopaque`, returning `moved@1`. The 768×1024 viewport check showed no cut-banner horizontal overflow and kept both action buttons visible.
- The normal Windows debug desktop build passed. This checkpoint changes frontend coordination only; the previous disposable SFTP move probes establish provider behavior. A native GUI Cut/Paste move walkthrough and physical-network interruption remain separate integration checks.
