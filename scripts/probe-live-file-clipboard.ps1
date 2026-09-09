# SPDX-License-Identifier: MPL-2.0
param([switch]$AllowClipboardReplacement)
$ErrorActionPreference = 'Stop'
if (!$AllowClipboardReplacement) { throw 'Opt-in required. This test exchanges generated files on the clipboard, restores supported text/image formats, and cannot restore AnyDesk private metadata.' }
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Run with powershell.exe -NoProfile -STA -File.' }
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -Path (Join-Path $PSScriptRoot 'file-clipboard-probe.cs')
$workspacePath = Split-Path -Parent $PSScriptRoot
$build = @(Get-Content -LiteralPath (Join-Path $workspacePath '.local/file-clipboard-build.jsonl') | ConvertFrom-Json)
if ($build[-1].reason -ne 'build-finished' -or !$build[-1].success) { throw 'Build the Rust test executable first, as documented.' }
$artifact = $build | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'shellcanvas_app' -and $_.profile.test -and $_.executable } | Select-Object -Last 1
if (!$artifact -or !(Test-Path -LiteralPath $artifact.executable -PathType Leaf)) { throw 'Built native test executable missing.' }
$run = [Guid]::NewGuid().ToString('D')
$directory = Join-Path $workspacePath ".local/live-file-clipboard/$run"
New-Item -ItemType Directory -Path $directory | Out-Null
$snapshot = New-Object FileClipboardProbe
$report = [ordered]@{ success = $false; run = $run; hashes = @(); native = $null; clipboardRestored = $false; anyDeskMetadataNotRestored = $snapshot.AnyDeskMetadataNotRestored; scope = 'Actual Windows OLE streams and file list with generated local files; no Explorer UI or remote host access' }
$nativeProcess = $null
$failure = $null
$previousRun = $env:SHELLCANVAS_FILE_CLIPBOARD_RUN
try {
    $snapshot.AssertUnchanged()
    $env:SHELLCANVAS_FILE_CLIPBOARD_RUN = $run
    $nativeProcess = Start-Process -FilePath $artifact.executable -ArgumentList @('windows_clipboard::tests::explorer_clipboard_probe', '--ignored', '--exact', '--nocapture') -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'native.stdout.txt') -RedirectStandardError (Join-Path $directory 'native.stderr.txt')
    $ready = Join-Path $directory 'ready.json'
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (!(Test-Path -LiteralPath $ready)) {
        if ($nativeProcess.HasExited) { throw 'Native file probe exited before publication.' }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Native file publication timed out.' }
        Start-Sleep -Milliseconds 100
    }
    $report.hashes = [FileClipboardProbe]::Consume($directory, $run)
    [FileClipboardProbe]::PublishFiles($directory, $run)
    if (!$nativeProcess.WaitForExit(20000)) { throw 'Native file list read timed out.' }
    $report.native = Get-Content -LiteralPath (Join-Path $directory 'native-result.json') -Raw | ConvertFrom-Json
    if (!$report.native.success) { throw 'Native file list verification failed.' }
    $report.success = $true
} catch { $failure = $_.Exception.Message }
finally {
    # Restore while the producer is still alive, and only while this run owns the value.
    try { $report.clipboardRestored = $snapshot.Restore($directory, $run) }
    catch { $failure = 'Clipboard restoration failed: ' + $_.Exception.Message }
    if ($null -ne $nativeProcess -and !$nativeProcess.HasExited) { $nativeProcess.Kill(); $null = $nativeProcess.WaitForExit(5000) }
    $snapshot.Dispose()
    $env:SHELLCANVAS_FILE_CLIPBOARD_RUN = $previousRun
    if ($failure) { $report.error = $failure; $report.success = $false }
    $json = $report | ConvertTo-Json -Depth 8
    $json | Set-Content -LiteralPath (Join-Path $directory 'result.json')
    $json | Set-Content -LiteralPath (Join-Path $workspacePath '.local/live-file-clipboard/result.json')
    Write-Output $json
}
if (!$report.success) { exit 1 }
