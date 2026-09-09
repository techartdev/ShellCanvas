# File clipboard

Current Copy/Paste, multi-file downloads and Windows clipboard behavior are documented in [File clipboard and Windows transfers](system-clipboard.md). This supersedes the single-item clipboard limitations below.

Windows Cut intent is now owned natively and shared with runtime-app Paste in the
same workspace. Cancel cut retires the native reservation; dispatched moves cannot
be replayed. See [current Cut ownership, tests and remaining integration work](app-clipboard.md).
The earlier retry and in-memory-only behavior below describes its historical checkpoint.

## Earlier single-item Cut/Paste checkpoint

Files supports one pending cut per connected workspace. Select a file, folder or symlink and use **Cut** (Ctrl+X). Browse to a destination in the same or another Files window, then use **Paste here** (Ctrl+V). A folder's context menu also offers **Paste into folder**. The banner shows the item and its original location; **Cancel cut** or Escape outside editable fields clears it without contacting the host.

Cut only records the item. Paste calls the existing revision-checked, no-replacement move service. It moves the item with its name intact, including nonempty folders where the provider supports them. The source and destination listings refresh, and open editors/Files views follow the same provider relocation mappings as Move to folder. The clipboard survives closing the source Files window, but never crosses workspace/service bindings or survives disconnect, reconnect or application restart.

The file clipboard is separate from the OS text clipboard. Copy name/path/text and Go to clipboard path continue to use text. Pasting in an address, filter or editor remains text editing; pasting on the Files surface uses the pending remote item. Native Cut/Paste edit events and keyboard shortcuts both work, without interpreting external clipboard text as a remote move request.

Copy also handles native edit-menu events, which can arrive without a keyboard event. On the file list it copies the selected item's exact provider location, or the current folder when nothing is selected. In a preview it copies text selected inside that preview, or the full preview when there is no selection there. Address/filter text editing remains native. A successful retry clears a previous copy error. Go to clipboard path opens a folder; empty, multiline and oversized text is rejected before calling the provider.

Only one clipboard move can run at a time. While it runs, the item cannot be replaced or canceled. A failed move retains the original item/revision and displays the error; retry is always explicit. For an uncertain remote outcome, inspect the destination before retrying. The underlying SFTP revision is a metadata precondition, with the [same limitations as other file actions](file-actions.md); it is not a content hash or distributed lock. A confirmed rename/move of the cut item or its parent clears the cut because relocation mappings do not include a replacement revision. Confirmed deletion clears it too. External changes are checked by the provider on Paste and may require refreshing and cutting again.

Cut/Paste requires `files.move`. Source/destination tokens are opaque: the clipboard never constructs paths. Its two tracked locations count toward the existing 256-location relocation limit. Read-only sessions cannot gain move access through the clipboard. The separate [Copy to folder action](transfers.md#copy-to-folder) copies one regular file through the transfer queue. Remote Copy/Paste, multi-selection, cross-host transfer and persistent clipboard remain unimplemented.

## Verification

- A Windows native walkthrough passed selected-file path and full-preview text copying into editor drafts through the OS clipboard, copied-folder navigation in a second Files instance, Ctrl+X and Paste here with a shared pending item, and exact remote move readback/cleanup. See [native file workflows](native-file-workflows.md). Native selected-substring copy, keyboard-triggered file paste and interrupted transfers remain separate from these checks.

- The text clipboard browser fixture passed selected opaque-path Copy through a native copy event, full preview text and a selected word, untouched address-field Copy, clipboard-folder navigation isolated to the second Files window, multiline rejection and read/write failure recovery. The fixture exposes clipboard text and refusal controls for repeatable checks. Sixty frontend tests passed. These browser checks use a fake clipboard service; selected-file/preview OS clipboard integration remains a separate native gate.

- Seven clipboard tests cover shared immutable selections, exact opaque tokens and revisions, same-folder/self refusal, one-shot success, explicit retry after failure, duplicate/pending actions, capability checks, host isolation, disconnect and late outcomes, relocation invalidation and deletion outcomes. The full frontend suite passed 54 tests.
- The two-window browser fixture passed context-menu Cut, shared indicators, collision refusal with both original items intact, successful retry into an empty folder, both listings refreshing, shortcut/edit-event cut and paste, ordinary address-field text paste, Escape cancellation and pasting after the source window closed.
- The opaque fixture passed `object@93?kind=text` into `node@19%2Fopaque`, returning `moved@1`. The 768×1024 viewport check showed no cut-banner horizontal overflow and kept both action buttons visible.
- The normal Windows debug desktop build passed. This checkpoint changes frontend coordination only; the previous disposable SFTP move probes establish provider behavior. The subsequent native GUI Cut/Paste happy path is recorded above; physical-network interruption remains a separate integration check.
