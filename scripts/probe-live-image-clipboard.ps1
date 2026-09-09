# SPDX-License-Identifier: MPL-2.0
param([switch]$AllowClipboardReplacement)
$ErrorActionPreference = 'Stop'
if (!$AllowClipboardReplacement) { throw 'Opt-in required. This test replaces the clipboard, restores supported text/image formats, and cannot restore AnyDesk private metadata.' }
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Run with powershell.exe -NoProfile -STA -File.' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
public static class ClipboardProbeInterop {
    // Keep bitmap/stream values inside .NET: PowerShell's object wrapper is not
    // an OLE clipboard payload and must not reach DataObject.SetData(object).
    public static void StoreBitmap(DataObject target, string format, Bitmap value) { target.SetData(format, false, value); }
    public static void StoreStream(DataObject target, string format, MemoryStream value) { target.SetData(format, false, value); }
    public static void StoreString(DataObject target, string format, string value) { target.SetData(format, false, value); }
    public static void StoreBytes(DataObject target, string format, byte[] value) { target.SetData(format, false, value); }
    public static void Publish(int[] pixels) {
        using (var bitmap = new Bitmap(2, 2)) {
            for (int i = 0; i < 4; i++) bitmap.SetPixel(i % 2, i / 2, Color.FromArgb(pixels[i]));
            var data = new DataObject();
            data.SetData(DataFormats.Bitmap, true, bitmap);
            Clipboard.SetDataObject(data, true, 20, 100);
        }
    }
}
'@
$workspacePath = Split-Path -Parent $PSScriptRoot
$probeDirectory = Join-Path $workspacePath '.local/native-extension-probe'
$reportDirectory = Join-Path $workspacePath '.local/live-image-clipboard'
$probeExecutable = Join-Path $reportDirectory 'shellcanvas.exe'
if (!(Test-Path -LiteralPath $probeExecutable -PathType Leaf)) { throw 'Build and copy the dedicated fixture executable as documented before running this test.' }
$nativeResult = Join-Path $probeDirectory 'result.json'
$progressPath = Join-Path $probeDirectory 'progress.jsonl'
$snapshot = [Windows.Forms.Clipboard]::GetDataObject()
$formats = if ($null -eq $snapshot) { @() } else { @($snapshot.GetFormats($false)) }
$unsupported = @($formats | Where-Object { $_ -notin @('UnicodeText', 'Text', 'System.String', 'Locale', 'AnyDesk_DataObject', 'Bitmap', 'PNG', 'CanUploadToCloudClipboard', 'CanIncludeInClipboardHistory') })
if ($unsupported.Count) { throw 'Clipboard has formats this runner cannot preserve. Clipboard was left unchanged.' }
$hadText = [Windows.Forms.Clipboard]::ContainsText([Windows.Forms.TextDataFormat]::UnicodeText)
$restoreData = New-Object Windows.Forms.DataObject
$savedFormats = @($formats | Where-Object { $_ -ne 'AnyDesk_DataObject' })
$ownedValues = New-Object 'System.Collections.Generic.List[System.IDisposable]'
# Materialize every supported value before publication; the original IDataObject
# may become unavailable as soon as the native fixture owns the clipboard.
foreach ($format in $savedFormats) {
    $value = $snapshot.GetData($format, $false)
    if ($value -is [Drawing.Bitmap]) {
        $copy = $value.Clone()
        $ownedValues.Add($copy)
    } elseif ($value -is [IO.MemoryStream]) {
        $copy = New-Object IO.MemoryStream
        $bytes = $value.ToArray()
        $copy.Write($bytes, 0, $bytes.Length)
        $copy.Position = 0
        $ownedValues.Add($copy)
    } elseif ($value -is [string]) { $copy = $value }
    elseif ($value -is [byte[]]) { $copy = $value.Clone() }
    else {
        foreach ($ownedValue in $ownedValues) { $ownedValue.Dispose() }
        throw 'Unsupported clipboard value type; clipboard was left unchanged.'
    }
    if ($copy -is [Drawing.Bitmap]) { [ClipboardProbeInterop]::StoreBitmap($restoreData, $format, $copy) }
    elseif ($copy -is [IO.MemoryStream]) { [ClipboardProbeInterop]::StoreStream($restoreData, $format, $copy) }
    elseif ($copy -is [string]) { [ClipboardProbeInterop]::StoreString($restoreData, $format, $copy) }
    else { [ClipboardProbeInterop]::StoreBytes($restoreData, $format, $copy) }
}
$outgoing = @(-65536, -16711936, -16776961, -1)
$incoming = @(-16777216, -256, -16711681, -65281)
function Test-ClipboardImage($pixels) {
    $bitmap = [Windows.Forms.Clipboard]::GetImage()
    if ($null -eq $bitmap) { return $false }
    try {
        if ($bitmap.Width -ne 2 -or $bitmap.Height -ne 2) { return $false }
        for ($index = 0; $index -lt 4; $index++) {
            if ($bitmap.GetPixel($index % 2, [int][Math]::Floor($index / 2)).ToArgb() -ne $pixels[$index]) { return $false }
        }
        return $true
    } finally { $bitmap.Dispose() }
}
$report = [ordered]@{ success = $false; native = $null; windowsConsumedImage = $false; clipboardRestored = $false; clipboardTextRestored = $false; anyDeskMetadataNotRestored = ($formats -contains 'AnyDesk_DataObject'); scope = 'Live Windows image clipboard interoperability with production service; does not test Paint UI or transparent pixels' }
$nativeProcess = $null
$failure = $null
try {
    New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
    if (Test-Path -LiteralPath $nativeResult) { Remove-Item -LiteralPath $nativeResult }
    if (Test-Path -LiteralPath $progressPath) { Remove-Item -LiteralPath $progressPath }
    $env:SHELLCANVAS_EXTENSION_PROBE = '1'
    $env:SHELLCANVAS_LIVE_CLIPBOARD_PROBE = '1'
    $nativeProcess = Start-Process -FilePath $probeExecutable -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        if ($nativeProcess.HasExited) { throw 'Native image probe exited before publication.' }
        $ready = (Test-Path -LiteralPath $progressPath) -and ((Get-Content -LiteralPath $progressPath -Raw) -match 'live-image-written')
        if (!$ready) { Start-Sleep -Milliseconds 100 }
    } until ($ready -or [DateTime]::UtcNow -ge $deadline)
    if (!$ready) { throw 'Native image publication timed out.' }
    if (!(Test-ClipboardImage $outgoing)) { throw 'Windows could not read the native image pixels.' }
    $report.windowsConsumedImage = $true
    [ClipboardProbeInterop]::Publish($incoming)
    if (!$nativeProcess.WaitForExit(20000)) { throw 'Native image read timed out.' }
    $report.native = Get-Content -LiteralPath $nativeResult -Raw | ConvertFrom-Json
    if ($report.native.success -ne $true) { throw 'Native image read failed. See the native result.' }
    $report.success = $true
} catch { $failure = $_.Exception.Message }
finally {
    if ($null -ne $nativeProcess -and !$nativeProcess.HasExited) { $nativeProcess.Kill(); $nativeProcess.WaitForExit() }
    try {
        # Never replace content the user or another app put on the clipboard meanwhile.
        if ((Test-ClipboardImage $outgoing) -or (Test-ClipboardImage $incoming)) {
            if ($savedFormats.Count) { [Windows.Forms.Clipboard]::SetDataObject($restoreData, $true, 20, 100) }
            else { [Windows.Forms.Clipboard]::Clear() }
            $restored = [Windows.Forms.Clipboard]::GetDataObject()
            foreach ($format in $savedFormats) {
                if (!$restored.GetDataPresent($format, $false)) { throw 'Restored clipboard is missing an original format.' }
                $expected = $restoreData.GetData($format, $false)
                $actual = $restored.GetData($format, $false)
                if ($expected -is [IO.MemoryStream]) {
                    if ($actual -isnot [IO.MemoryStream] -or [Convert]::ToBase64String($expected.ToArray()) -cne [Convert]::ToBase64String($actual.ToArray())) { throw 'Restored clipboard bytes differ.' }
                } elseif ($expected -is [string] -and $expected -cne $actual) { throw 'Restored clipboard text differs.' }
            }
            $report.clipboardRestored = $true
            $report.clipboardTextRestored = $hadText
        }
    } catch { $report.success = $false; $failure = 'Clipboard restoration failed.' }
    foreach ($ownedValue in $ownedValues) { $ownedValue.Dispose() }
    if ($failure) { $report.error = $failure; $report.success = $false }
    $json = $report | ConvertTo-Json -Depth 8
    $json | Set-Content -LiteralPath (Join-Path $reportDirectory 'result.json')
    Write-Output $json
}
if (!$report.success) { exit 1 }
