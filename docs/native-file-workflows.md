# Windows native file workflow verification

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
