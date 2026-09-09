// SPDX-License-Identifier: MPL-2.0
// Independent Windows OLE consumer for the opt-in Rust file clipboard probe.
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Windows.Forms;
using OleData = System.Runtime.InteropServices.ComTypes.IDataObject;

public sealed class FileClipboardProbe : IDisposable {
    [DllImport("ole32.dll")] static extern int OleGetClipboard(out OleData data);
    [DllImport("ole32.dll")] static extern void ReleaseStgMedium(ref STGMEDIUM medium);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string format);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    readonly DataObject saved = new DataObject();
    readonly List<IDisposable> owned = new List<IDisposable>();
    readonly string[] formats;
    public readonly bool AnyDeskMetadataNotRestored;
    readonly uint originalSequence;

    public FileClipboardProbe() {
        originalSequence = GetClipboardSequenceNumber();
        var original = Clipboard.GetDataObject();
        formats = original == null ? new string[0] : original.GetFormats(false);
        var allowed = new HashSet<string>(new[] { "UnicodeText", "Text", "System.String", "Locale", "Bitmap", "PNG", "CanUploadToCloudClipboard", "CanIncludeInClipboardHistory", "AnyDesk_DataObject" });
        try {
            foreach (string format in formats) {
                if (!allowed.Contains(format)) throw new Exception("Unsupported clipboard format; clipboard left unchanged.");
                if (format == "AnyDesk_DataObject") { AnyDeskMetadataNotRestored = true; continue; }
                object value = original.GetData(format, false);
                object copy;
                if (value is Bitmap) copy = ((Bitmap)value).Clone();
                else if (value is MemoryStream) copy = new MemoryStream(((MemoryStream)value).ToArray());
                else if (value is byte[]) copy = ((byte[])value).Clone();
                else if (value is string) copy = value;
                else throw new Exception("Unsupported clipboard value; clipboard left unchanged.");
                if (copy is IDisposable) owned.Add((IDisposable)copy);
                // Keep typed objects inside .NET; PowerShell wrappers are not OLE payloads.
                saved.SetData(format, false, copy);
            }
            AssertUnchanged();
        } catch { Dispose(); throw; }
    }

    public void AssertUnchanged() {
        if (GetClipboardSequenceNumber() != originalSequence) throw new Exception("Clipboard changed before the probe; left unchanged.");
    }

    static FORMATETC Format(string name, int index, TYMED medium) {
        return new FORMATETC { cfFormat = unchecked((short)RegisterClipboardFormat(name)), dwAspect = DVASPECT.DVASPECT_CONTENT, lindex = index, tymed = medium };
    }

    sealed class Entry { public string Name; public long Size; public bool Directory; }
    static Entry[] Descriptors(OleData data) {
        var format = Format("FileGroupDescriptorW", -1, TYMED.TYMED_HGLOBAL);
        STGMEDIUM medium;
        data.GetData(ref format, out medium);
        try {
            ulong allocation = GlobalSize(medium.unionmember).ToUInt64();
            if (allocation < 4) throw new Exception("Truncated descriptor group.");
            IntPtr pointer = GlobalLock(medium.unionmember);
            if (pointer == IntPtr.Zero) throw new Exception("Cannot lock descriptors.");
            try {
                int count = Marshal.ReadInt32(pointer);
                if (count != 5 || allocation < (ulong)(4 + count * 592)) throw new Exception("Unexpected probe descriptors.");
                var entries = new Entry[count];
                for (int i = 0; i < count; i++) {
                    IntPtr item = IntPtr.Add(pointer, 4 + i * 592);
                    entries[i] = new Entry {
                        Name = Marshal.PtrToStringUni(IntPtr.Add(item, 72), 260).Split('\0')[0],
                        Directory = (Marshal.ReadInt32(item, 36) & 16) != 0,
                        Size = ((long)(uint)Marshal.ReadInt32(item, 64) << 32) | (uint)Marshal.ReadInt32(item, 68)
                    };
                }
                return entries;
            } finally { GlobalUnlock(medium.unionmember); }
        } finally { ReleaseStgMedium(ref medium); }
    }

    public static string[] Consume(string directory, string run) {
        Guid.ParseExact(run, "D");
        string root = "ShellCanvas-" + run;
        var expected = new[] { root, root + "\\Nested", root + "\\Empty", root + "\\Nested\\First.bin", root + "\\Second.bin" };
        OleData data;
        Marshal.ThrowExceptionForHR(OleGetClipboard(out data));
        try {
            var entries = Descriptors(data);
            for (int i = 0; i < entries.Length; i++) {
                if (entries[i].Name != expected[i] || entries[i].Directory != (i < 3) || (i >= 3 && entries[i].Size != 8388625))
                    throw new Exception("Clipboard is not the expected generated fixture.");
            }
            if (Directory.Exists(Path.Combine(directory, root))) throw new Exception("Refusing an existing fixture destination.");
            for (int i = 0; i < 3; i++) Directory.CreateDirectory(Path.Combine(directory, expected[i]));
            var hashes = new string[2];
            for (int i = 3; i < 5; i++) {
                var format = Format("FileContents", i, TYMED.TYMED_ISTREAM);
                STGMEDIUM medium;
                data.GetData(ref format, out medium);
                try {
                    var stream = (IStream)Marshal.GetObjectForIUnknown(medium.unionmember);
                    IntPtr readCount = Marshal.AllocCoTaskMem(4);
                    try {
                        using (var file = new FileStream(Path.Combine(directory, expected[i]), FileMode.CreateNew, FileAccess.ReadWrite)) {
                            byte[] buffer = new byte[32768];
                            long position = 0;
                            while (true) {
                                stream.Read(buffer, buffer.Length, readCount);
                                int count = Marshal.ReadInt32(readCount);
                                if (count < 0 || count > buffer.Length) throw new Exception("Invalid stream byte count.");
                                if (count == 0) break;
                                if (position + count > entries[i].Size) throw new Exception("Stream exceeded declared size.");
                                for (int n = 0; n < count; n++) if (buffer[n] != (byte)((position + n) % 251)) throw new Exception("File bytes differ.");
                                file.Write(buffer, 0, count);
                                position += count;
                            }
                            if (position != entries[i].Size) throw new Exception("Truncated file stream.");
                            file.Position = 0;
                            using (var hash = SHA256.Create()) hashes[i - 3] = BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
                        }
                    } finally { Marshal.FreeCoTaskMem(readCount); Marshal.ReleaseComObject(stream); }
                } finally { ReleaseStgMedium(ref medium); }
            }
            return hashes;
        } finally { if (data != null) Marshal.ReleaseComObject(data); }
    }

    public static void PublishFiles(string directory, string run) {
        if (!IsOurs(directory, run)) throw new Exception("Clipboard changed during the probe; left unchanged.");
        var paths = new StringCollection();
        paths.Add(Path.Combine(directory, "ShellCanvas-" + run, "Nested", "First.bin"));
        paths.Add(Path.Combine(directory, "ShellCanvas-" + run, "Second.bin"));
        var data = new DataObject();
        data.SetFileDropList(paths);
        Clipboard.SetDataObject(data, true, 20, 100);
    }

    static bool IsOurs(string directory, string run) {
        try {
            if (Clipboard.ContainsFileDropList()) {
                var paths = Clipboard.GetFileDropList();
                return paths.Count == 2 && paths[0] == Path.Combine(directory, "ShellCanvas-" + run, "Nested", "First.bin")
                    && paths[1] == Path.Combine(directory, "ShellCanvas-" + run, "Second.bin");
            }
            OleData data;
            Marshal.ThrowExceptionForHR(OleGetClipboard(out data));
            try { return Descriptors(data)[0].Name == "ShellCanvas-" + run; }
            finally { if (data != null) Marshal.ReleaseComObject(data); }
        } catch { return false; }
    }

    public bool Restore(string directory, string run) {
        if (!IsOurs(directory, run)) return false;
        if (saved.GetFormats(false).Length == 0) Clipboard.Clear();
        else Clipboard.SetDataObject(saved, true, 20, 100);
        var restored = Clipboard.GetDataObject();
        foreach (string format in saved.GetFormats(false)) {
            if (!restored.GetDataPresent(format, false)) throw new Exception("Restored clipboard lost a format.");
            object expected = saved.GetData(format, false), actual = restored.GetData(format, false);
            if (expected is string && !String.Equals((string)expected, actual as string, StringComparison.Ordinal)) throw new Exception("Restored text differs.");
            if (expected is MemoryStream && (!(actual is MemoryStream) || Convert.ToBase64String(((MemoryStream)expected).ToArray()) != Convert.ToBase64String(((MemoryStream)actual).ToArray()))) throw new Exception("Restored stream differs.");
            if (expected is byte[] && (!(actual is byte[]) || Convert.ToBase64String((byte[])expected) != Convert.ToBase64String((byte[])actual))) throw new Exception("Restored bytes differ.");
        }
        return true;
    }

    public void Dispose() { foreach (var item in owned) item.Dispose(); owned.Clear(); }
}
