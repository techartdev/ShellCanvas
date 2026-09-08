# Windows native file workflow verification

## Regular-file copy follow-up

Verified 2026-09-08 using the production native copy action from `794d5b0` and the native workspace fixture. `tests/native_copy_fixture.py` created a fresh owned `/tmp/shellcanvas-native-copy-UUID` directory containing `sample.bin` and an empty `destination` folder. It does not copy files itself. The generated binary contained 8,388,674 bytes (SHA-256 `bb5d1c7e8dec6b6474340e51447d0906fc18943dcc452913ab1bd9a6f3a5b751`).

- Navigated the Windows Files window to the fixture using its location field, opened the file context menu, and selected **Copy to folder…**. The dialog disabled copying into the current folder, then enabled it after opening `destination` and displaying the exact destination.
- Started the copy through **Copy here**. The transfer panel displayed byte progress and Copying; owning-window close and workspace Disconnect were disabled during work. It then reported Completed and released those guards.
- Independent SSH readback verified both the retained source and copied file against the expected hash and byte length.
- Repeated the same action into the existing destination. The native transfer panel reported Failed and that nothing was replaced; independent readback again matched both files.
- Opened `destination` in Files and verified the copied 8 MB file appeared.
- The app exited normally. Cleanup verified the expected contents, removed only the two generated files and empty directories, and confirmed the UUID directory was absent. The standard embedded-assets Windows debug build passed and was restored after the walkthrough.

The long UUID folder name exposed excessive heading wrapping. Files now keeps that heading on one line with an ellipsis and a full-name tooltip, allowing the file list to retain its space. The running Windows UI verified both the long name and ordinary `destination` heading. Windows accessibility reported only the webview as focused, so location-field entry was verified from the visible caret and selected field text before typing.

This walkthrough covers real native success/collision/progress paths. Copy cancellation, stale revisions and cleanup failure cases remain covered by service/browser tests and the live provider probe; native cancellation and physical-network loss were not induced here.

The helper accepts `setup`, `verify` or `cleanup` and one exact UUID path. Run it through Python on an explicitly authorized Linux host; it refuses unexpected entries, changed contents and symlinks during verification/cleanup and never recursively deletes. Preserve the setup path until cleanup succeeds.

## Earlier clipboard and editor walkthrough

Verified 2026-09-08 against the production Tauri frontend and SSH/SFTP services at code checkpoint `0843068`, using the native workspace fixture and the authorized root connection to evtinsait. A new `/tmp/shellcanvas-ui-UUID` directory contained only two generated text files and an empty destination folder. No existing host files were edited.

## Clipboard and independent Files windows

- Selected `existing.txt` in Files, used Ctrl+C, opened an editor draft and pasted through Ctrl+V. The Windows clipboard delivered the exact full remote file path.
- Cut `move.txt` using Ctrl+X. A second Files instance displayed the same pending item while opening its own initial directory.
- Selected the destination folder in the source window and copied its path with Ctrl+C. This did not clear the separate pending cut item.
- Minimized the source window, then used **Go to clipboard path** in Files 2. It opened the copied destination folder with the pending cut still available.
- Used **Paste here** in Files 2. The cut indicator cleared and the moved file appeared. Independent SSH readback verified the old location was absent and the destination contained the exact original text.
- Opened the moved file's preview, focused its text surface and pressed Ctrl+C with no text selection. Pasting into a new editor draft produced the exact full preview text through the Windows clipboard. That temporary draft was cleared without saving.

The native paste check used the visible Paste here button; native Ctrl+V remote-item movement remains covered by the browser edit-event fixture rather than this walkthrough. Selected-substring copying is browser-verified; this native walkthrough covers full-preview copying.

## Save As replacement

An unnamed editor draft contained `ShellCanvas native replacement 🌍`. Save As was directed to the owned test folder and `existing.txt`. The review displayed the exact destination name/path. Independent readback while review was open confirmed the file still contained its original text.

After **Replace file**, the dialog closed, the editor adopted the destination, and its footer reported Saved to remote host. Independent SSH readback matched the replacement text, including the Unicode character. The saved editor closed without a dirty-work prompt. Conflict/permission/disconnect and sibling-draft handling remain covered by the synthetic fixtures and existing service probes; those failures were not induced in this native walkthrough.

## Cleanup and limits

The test app exited normally. Cleanup removed the exact generated `existing.txt` and `destination/move.txt`, removed the now-empty destination and test directories, and verified the test directory was absent. No recursive cleanup was used. The standard embedded-assets Windows debug build was restored after the native fixture run.

This verifies the listed Windows GUI paths against one real Linux/OpenSSH host. It does not establish physical-network interruption behavior, native editor relocation, other operating systems or other connectors. Those remain separate backlog gates.
