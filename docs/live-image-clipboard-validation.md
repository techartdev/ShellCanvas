# Live Windows image clipboard validation

This manual fixture tests the existing production image clipboard service against
the actual Windows clipboard. It adds no public API. The native WebView writes a
2×2 opaque RGBA image and reads it back. A separate Windows Forms process checks
every pixel, publishes a different image, and waits for the native service to
read that image with the same dimensions and bytes.

The installed-app fixture separately checks SDK permissions, broker routing and
native image-resource lifetime with injected clipboard content. Neither test
alone proves the other's boundary. This live fixture does not test Paint UI,
transparent pixels, native file transfers, or another operating system.

## Manual execution

Build the fixture before running it:

```powershell
npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.live-image-clipboard-probe.conf.json
New-Item -ItemType Directory -Force .local/live-image-clipboard
Copy-Item target/debug/shellcanvas.exe .local/live-image-clipboard/shellcanvas.exe
```

An ordinary fixture launch must report the missing explicit opt-in and exit
before reading or writing clipboard content:

```powershell
node scripts/run-extension-probe.mjs
```

For the live exchange, first arrange a time when temporarily replacing the
clipboard is acceptable. The runner preserves supported text, bitmap/PNG and
Windows history/cloud flags in memory, never prints or saves their contents,
and refuses unsupported initial formats or value types. It cannot restore
AnyDesk's private clipboard metadata. AnyDesk or other clipboard synchronization
software may also observe the temporary test images. Run only after accepting
that effect:

```powershell
powershell.exe -NoProfile -STA -File scripts/probe-live-image-clipboard.ps1 -AllowClipboardReplacement
```

The runner restores the saved formats only if the clipboard still holds one of its
test images. It leaves newer clipboard content from another app or the user alone.
The outcome is written to `.local/live-image-clipboard/result.json`; no original
clipboard content is included. Require `success`, `windowsConsumedImage` and both
native checks to be true. Inspect `clipboardRestored` separately: a newer
clipboard value may intentionally prevent restoration. Restored PNG and flag
streams are compared byte-for-byte in memory; text is compared exactly.

Always restore the normal development executable afterward:

```powershell
npm run tauri -- build --debug --no-bundle
```

## Evidence status

The native build and TypeScript check pass. Launching without live-test opt-in
was verified to return the guard error before clipboard access; the result is
retained in `.local/native-extension-probe/live-image-opt-in-guard.json`.
The approved live exchange passed on Windows on 2026-09-09. The production service
round trip, independent Windows pixel read and Windows-produced image read all
passed. The original bitmap/PNG and clipboard flags were restored; the retained
report is `.local/live-image-clipboard/result.json` with `success` and
`clipboardRestored` true. This proves the stated opaque-image path, not every
clipboard format or file-transfer path.

The first reverse-write attempts failed in the PowerShell harness. Publishing
the bitmap within typed .NET code removed PowerShell object wrapping; the final
runner uses typed payloads for both test publication and preserved formats.
No production clipboard API change was needed.
