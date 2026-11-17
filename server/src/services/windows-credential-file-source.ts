export const WINDOWS_CREDENTIAL_FILE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class WindowsCredentialReader {
  [StructLayout(LayoutKind.Sequential)]
  struct FileInfo {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint GetFileType(SafeFileHandle file);
  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeName { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct ObjectAttributes {
    public uint Length;
    public IntPtr RootDirectory, ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [DllImport("ntdll.dll")]
  static extern int NtCreateFile(out SafeFileHandle file, uint access, ref ObjectAttributes attributes,
    out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition,
    uint options, IntPtr ea, uint eaLength);

  static SafeFileHandle Checked(SafeFileHandle handle, bool directory) {
    if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Invalid credential file"); }
    FileInfo info;
    if (!GetFileInformationByHandle(handle, out info) || GetFileType(handle) != 1
      || (info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory
      || (!directory && (info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 65536))) {
      handle.Dispose(); throw new IOException("Invalid credential file");
    }
    return handle;
  }

  static SafeFileHandle OpenRoot(string path) {
    return Checked(CreateFileW(path, 0x80000000u, 1u,
      IntPtr.Zero, 3, 0x02200000u, IntPtr.Zero), true);
  }

  static SafeFileHandle OpenChild(SafeFileHandle parent, string name, bool directory) {
    if (name.Length > 32766) throw new IOException("Invalid credential file");
    var buffer = Marshal.StringToHGlobalUni(name);
    var pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));
    try {
      var text = new UnicodeName { Length = (ushort)(name.Length * 2), MaximumLength = (ushort)(name.Length * 2 + 2), Buffer = buffer };
      Marshal.StructureToPtr(text, pointer, false);
      var attributes = new ObjectAttributes { Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)),
        RootDirectory = parent.DangerousGetHandle(), ObjectName = pointer, Attributes = 0x1040 };
      SafeFileHandle handle;
      IoStatus status;
      var result = NtCreateFile(out handle, 0x80100000u, ref attributes, out status, IntPtr.Zero,
        0, 1, 1, 0x00200020u | (directory ? 1u : 0x40u), IntPtr.Zero, 0);
      if (result < 0) { if (handle != null) handle.Dispose(); throw new IOException("Invalid credential file"); }
      return Checked(handle, directory);
    } finally { Marshal.FreeHGlobal(pointer); Marshal.FreeHGlobal(buffer); }
  }

  public static byte[] Read(string filename, Action beforeRead) {
    if (String.IsNullOrEmpty(filename) || !Path.IsPathRooted(filename)
      || filename.StartsWith(@"\\?\") || filename.StartsWith(@"\\.\")) throw new IOException("Invalid credential file");
    var full = Path.GetFullPath(filename);
    var root = Path.GetPathRoot(full);
    var parts = full.Substring(root.Length).Split(Path.DirectorySeparatorChar);
    if (parts.Length == 0) throw new IOException("Invalid credential file");
    foreach (var part in parts) {
      if (String.IsNullOrEmpty(part) || part == "." || part == ".." || part.IndexOf(':') >= 0
        || part.EndsWith(".") || part.EndsWith(" ")) throw new IOException("Invalid credential file");
    }
    var held = new List<SafeFileHandle>();
    try {
      held.Add(OpenRoot(root));
      for (var index = 0; index < parts.Length - 1; index++) {
        held.Add(OpenChild(held[held.Count - 1], parts[index], true));
      }
      if (beforeRead != null) beforeRead();
      using (var handle = OpenChild(held[held.Count - 1], parts[parts.Length - 1], false))
      using (var stream = new FileStream(handle, FileAccess.Read)) {
        var bytes = new byte[65537];
        var count = 0;
        int read;
        while (count < bytes.Length && (read = stream.Read(bytes, count, bytes.Length - count)) > 0) count += read;
        if (count > 65536) throw new IOException("Invalid credential file");
        var result = new byte[count];
        Buffer.BlockCopy(bytes, 0, result, 0, count);
        Array.Clear(bytes, 0, bytes.Length);
        return result;
      }
    } finally {
      for (var index = held.Count - 1; index >= 0; index--) held[index].Dispose();
    }
  }

  static int Main(string[] args) {
    try {
      if (args.Length != 0) return 1;
      var bytes = Read(Console.ReadLine(), null);
      try { Console.Write(Convert.ToBase64String(bytes)); }
      finally { Array.Clear(bytes, 0, bytes.Length); }
      return 0;
    } catch { return 1; }
  }
}
`;
