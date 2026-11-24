# Windows PowerShell 5.1, x64. All preference writes use WinINet APIs.
param([Parameter(Mandatory=$true)][ValidateSet('read','write')][string]$Command)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Fail([string]$code) {
  [Console]::Out.Write('{"error":"' + $code + '"}')
  exit 1
}
if ([IntPtr]::Size -ne 8) { Fail 'unsupported' }

try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32;

public sealed class ProxyFailure : Exception {
    public readonly string Code;
    public ProxyFailure(string code) : base(code) { Code = code; }
}
public sealed class WinInetState {
    public uint flags;
    public string proxyServer;
    public string proxyBypass;
    public string autoConfigURL;
    public uint autoDiscoveryFlags;
}
public static class MockManagerWinInet {
    // Microsoft: query FLAGS_UI on modern Windows; restore using FLAGS.
    // https://learn.microsoft.com/windows/win32/api/wininet/ns-wininet-internet_per_conn_optiona
    [StructLayout(LayoutKind.Explicit)] struct OptionValue {
        [FieldOffset(0)] public uint Number;
        [FieldOffset(0)] public IntPtr String;
        [FieldOffset(0)] public long FileTime;
    }
    [StructLayout(LayoutKind.Sequential)] struct Option { public uint Id; public OptionValue Value; }
    [StructLayout(LayoutKind.Sequential)] struct OptionList {
        public uint Size;
        public IntPtr Connection; // NULL means LAN, not a VPN or dial-up connection.
        public uint Count;
        public uint Error;
        public IntPtr Options;
    }
    [DllImport("wininet.dll", EntryPoint="InternetQueryOptionW", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool Query(IntPtr internet, uint option, ref OptionList list, ref uint size);
    [DllImport("wininet.dll", EntryPoint="InternetSetOptionW", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool Set(IntPtr internet, uint option, ref OptionList list, uint size);
    [DllImport("wininet.dll", EntryPoint="InternetSetOptionW", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool Notify(IntPtr internet, uint option, IntPtr buffer, uint size);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr value);

    static void EnsurePolicySupported() {
        // Registry is read for policy detection only, never used to write proxy preferences.
        foreach (RegistryKey hive in new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine }) {
            foreach (string path in new string[] {
                @"Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings",
                @"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
            }) using (RegistryKey key = hive.OpenSubKey(path, false)) {
                if (key == null) continue;
                object scope = key.GetValue("ProxySettingsPerUser");
                if (scope != null && (!(scope is int) || (int)scope != 1)) throw new ProxyFailure("unsupportedPolicy");
                if (path.IndexOf(@"\Policies\", StringComparison.Ordinal) >= 0) {
                    foreach (string name in new string[] { "ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL", "AutoDetect" })
                        if (key.GetValue(name) != null) throw new ProxyFailure("unsupportedPolicy");
                }
            }
            using (RegistryKey key = hive.OpenSubKey(@"Software\Policies\Microsoft\Internet Explorer\Control Panel", false)) {
                if (key == null) continue;
                foreach (string name in new string[] { "Proxy", "Connections", "Autoconfig" }) {
                    object restriction = key.GetValue(name);
                    if (restriction != null && (!(restriction is int) || (int)restriction != 0)) throw new ProxyFailure("unsupportedPolicy");
                }
            }
        }
    }
    static void Validate(WinInetState value) {
        if (value == null || value.flags > 15) throw new ProxyFailure("invalidRequest");
        foreach (string text in new string[] { value.proxyServer, value.proxyBypass, value.autoConfigURL })
            if (text != null && (text.Length > 32767 || text.IndexOf('\0') >= 0)) throw new ProxyFailure("invalidRequest");
        foreach (string text in new string[] { value.proxyServer, value.autoConfigURL })
            if (text != null && (text.IndexOf('@') >= 0 || text.IndexOf("%40", StringComparison.OrdinalIgnoreCase) >= 0))
                throw new ProxyFailure("credentials");
    }
    static bool Same(WinInetState a, WinInetState b) {
        return a.flags == b.flags && a.proxyServer == b.proxyServer && a.proxyBypass == b.proxyBypass
            && a.autoConfigURL == b.autoConfigURL && a.autoDiscoveryFlags == b.autoDiscoveryFlags;
    }
    static OptionList NewList(uint firstOption) {
        int size = Marshal.SizeOf(typeof(Option));
        IntPtr options = Marshal.AllocHGlobal(size * 5);
        uint[] ids = new uint[] { firstOption, 2, 3, 4, 5 };
        for (int i = 0; i < ids.Length; i++) {
            Option option = new Option(); option.Id = ids[i];
            Marshal.StructureToPtr(option, IntPtr.Add(options, size * i), false);
        }
        OptionList list = new OptionList();
        list.Size = (uint)Marshal.SizeOf(typeof(OptionList)); list.Count = 5; list.Options = options;
        return list;
    }
    static Option Get(OptionList list, int i) {
        return (Option)Marshal.PtrToStructure(IntPtr.Add(list.Options, Marshal.SizeOf(typeof(Option)) * i), typeof(Option));
    }
    static void Free(OptionList list, bool query) {
        for (int i = 1; i <= 3; i++) {
            IntPtr value = Get(list, i).Value.String;
            if (value != IntPtr.Zero) { if (query) GlobalFree(value); else Marshal.FreeHGlobal(value); }
        }
        Marshal.FreeHGlobal(list.Options);
    }
    static WinInetState ReadCore(uint flagOption) {
        OptionList list = NewList(flagOption);
        try {
            uint size = list.Size;
            if (!Query(IntPtr.Zero, 75, ref list, ref size)) throw new ProxyFailure("readFailed");
            WinInetState result = new WinInetState();
            result.flags = Get(list, 0).Value.Number;
            result.proxyServer = Marshal.PtrToStringUni(Get(list, 1).Value.String);
            result.proxyBypass = Marshal.PtrToStringUni(Get(list, 2).Value.String);
            result.autoConfigURL = Marshal.PtrToStringUni(Get(list, 3).Value.String);
            result.autoDiscoveryFlags = Get(list, 4).Value.Number;
            Validate(result);
            return result;
        } finally { Free(list, true); }
    }
    static WinInetState ReadCurrent() {
        try { return ReadCore(10); }
        catch (ProxyFailure failure) { if (failure.Code != "readFailed") throw; return ReadCore(1); }
    }
    static void WriteCore(WinInetState value) {
        OptionList list = NewList(1);
        try {
            for (int i = 0; i < 5; i++) {
                Option option = Get(list, i);
                if (i == 0) option.Value.Number = value.flags;
                else if (i == 4) option.Value.Number = value.autoDiscoveryFlags;
                else {
                    string text = i == 1 ? value.proxyServer : i == 2 ? value.proxyBypass : value.autoConfigURL;
                    option.Value.String = text == null ? IntPtr.Zero : Marshal.StringToHGlobalUni(text);
                }
                Marshal.StructureToPtr(option, IntPtr.Add(list.Options, Marshal.SizeOf(typeof(Option)) * i), false);
            }
            if (!Set(IntPtr.Zero, 75, ref list, list.Size)) throw new ProxyFailure("updateFailed");
            // Broadcast to WinINet instances and refresh the process cache. A failure
            // after persistence is reported separately so the journal remains recoverable.
            bool changed = Notify(IntPtr.Zero, 95, IntPtr.Zero, 0);
            bool refreshed = Notify(IntPtr.Zero, 37, IntPtr.Zero, 0);
            if (!changed || !refreshed) throw new ProxyFailure("applyFailed");
        } finally { Free(list, false); }
    }
    static T Locked<T>(Func<T> action) {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        using (Mutex mutex = new Mutex(false, @"Local\MockManager.WinInet.Proxy." + sid)) {
            bool held = false;
            try {
                try { held = mutex.WaitOne(10000); } catch (AbandonedMutexException) { held = true; }
                if (!held) throw new ProxyFailure("busy");
                EnsurePolicySupported();
                return action();
            } finally { if (held) mutex.ReleaseMutex(); }
        }
    }
    public static WinInetState Read() { return Locked<WinInetState>(delegate { return ReadCurrent(); }); }
    public static void CompareAndWrite(WinInetState expected, WinInetState next) {
        Validate(expected); Validate(next);
        Locked<bool>(delegate {
            if (!Same(ReadCurrent(), expected)) throw new ProxyFailure("conflict");
            EnsurePolicySupported();
            // WinINet has no atomic compare-and-swap API. The mutex serializes our
            // helpers; this fresh comparison protects against preexisting external edits.
            WriteCore(next);
            return true;
        });
    }
}
'@

function Parse-State($value) {
  if ($null -eq $value -or ($value.enabled -isnot [bool] -or $value.enabled -cne $true) -or $null -eq $value.configuration) { throw [ProxyFailure]::new('invalidRequest') }
  $config = $value.configuration
  $keys = @($config.PSObject.Properties.Name)
  if ($keys.Count -ne 5) { throw [ProxyFailure]::new('invalidRequest') }
  foreach ($name in @('flags', 'proxyServer', 'proxyBypass', 'autoConfigURL', 'autoDiscoveryFlags')) {
    if ($keys -cnotcontains $name) { throw [ProxyFailure]::new('invalidRequest') }
  }
  foreach ($name in @('flags', 'autoDiscoveryFlags')) {
    $number = $config.$name
    if (($number -isnot [int] -and $number -isnot [long]) -or $number -lt 0 -or $number -gt [uint32]::MaxValue) { throw [ProxyFailure]::new('invalidRequest') }
  }
  foreach ($name in @('proxyServer', 'proxyBypass', 'autoConfigURL')) {
    if ($null -ne $config.$name -and $config.$name -isnot [string]) { throw [ProxyFailure]::new('invalidRequest') }
  }
  $result = New-Object WinInetState
  $result.flags = [uint32]$config.flags
  # Assigning PowerShell $null to a typed C# string coerces it to ''. Keep
  # the newly constructed field's null default; an actual empty string is set.
  foreach ($name in @('proxyServer', 'proxyBypass', 'autoConfigURL')) {
    if ($null -ne $config.$name) { $result.$name = $config.$name }
  }
  $result.autoDiscoveryFlags = [uint32]$config.autoDiscoveryFlags
  return $result
}

if ($Command -ceq 'read') {
  $state = [MockManagerWinInet]::Read()
  $response = @{ location = 'wininet-current-user'; services = @(@{
    id = 'lan'; name = 'Windows LAN'; active = $true; enabled = $true; configuration = $state
  }) } | ConvertTo-Json -Compress -Depth 8
} else {
  # Do not use ReadToEnd: reject oversized input before allocating unbounded data.
  $builder = New-Object System.Text.StringBuilder
  $buffer = New-Object char[] 4096
  $bytes = 0
  while (($count = [Console]::In.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $bytes += [System.Text.Encoding]::UTF8.GetByteCount($buffer, 0, $count)
    if ($bytes -gt 1048576) { throw [ProxyFailure]::new('invalidRequest') }
    [void]$builder.Append($buffer, 0, $count)
  }
  try { $request = $builder.ToString() | ConvertFrom-Json } catch { throw [ProxyFailure]::new('invalidRequest') }
  if ($null -eq $request -or $request.changes -isnot [array] -or $request.changes.Count -ne 1 -or $request.changes[0].id -cne 'lan') { throw [ProxyFailure]::new('invalidRequest') }
  if ($null -ne $request.expectedLocation -and $request.expectedLocation -cne 'wininet-current-user') { throw [ProxyFailure]::new('conflict') }
  $expected = Parse-State $request.changes[0].expected
  $next = Parse-State $request.changes[0].next
  [MockManagerWinInet]::CompareAndWrite($expected, $next)
  $response = '{"ok":true}'
}
if ([System.Text.Encoding]::UTF8.GetByteCount($response) -gt 2097152) { Fail 'invalidResponse' }
[Console]::Out.Write($response)
} catch {
  $failure = $_.Exception
  while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  if ($failure.GetType().Name -ceq 'ProxyFailure') { Fail $failure.Code }
  # Never emit OS exception text: it may include private proxy values or user paths.
  if ($Command -ceq 'read') { Fail 'readFailed' } else { Fail 'updateFailed' }
}
