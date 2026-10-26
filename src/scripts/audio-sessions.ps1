# 列出当前默认输出设备上各音频会话的峰值，按应用区分；供 World 判断“到底是谁在发声”。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$code = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace CorticoAudio
{
    public class SessionInfo
    {
        public int Pid;
        public float Peak;
        public int State;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl
    {
        int GetState(out int state);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
        int GetGroupingParam(out Guid grouping);
        int SetGroupingParam(ref Guid grouping, ref Guid eventContext);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2 : IAudioSessionControl
    {
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetProcessId(out int pid);
        int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl session);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        int GetAudioSessionControl(ref Guid audioSessionGuid, int streamFlags, out IAudioSessionControl sessionControl);
        int GetSimpleAudioVolume(ref Guid audioSessionGuid, int streamFlags, out IntPtr audioVolume);
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        int RegisterSessionNotification(IntPtr sessionNotification);
        int UnregisterSessionNotification(IntPtr sessionNotification);
        int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
        int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioMeterInformation
    {
        int GetPeakValue(out float peak);
        int GetMeteringChannelCount(out int count);
        int GetChannelsPeakValues(int count, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
        int QueryHardwareSupport(out int mask);
    }

    public static class AudioSessionPeaks
    {
        public static SessionInfo[] GetSessions()
        {
            var list = new List<SessionInfo>();
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice device;
            enumerator.GetDefaultAudioEndpoint(0, 1, out device); // eRender, eMultimedia

            Guid iid = typeof(IAudioSessionManager2).GUID;
            object obj;
            device.Activate(ref iid, 23, IntPtr.Zero, out obj); // CLSCTX_ALL
            var manager = (IAudioSessionManager2)obj;
            IAudioSessionEnumerator sessionEnum;
            manager.GetSessionEnumerator(out sessionEnum);

            int count;
            sessionEnum.GetCount(out count);
            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl ctrl;
                sessionEnum.GetSession(i, out ctrl);
                int state = 0;
                try { ctrl.GetState(out state); } catch { }

                int pid = 0;
                try
                {
                    var c2 = ctrl as IAudioSessionControl2;
                    if (c2 != null) c2.GetProcessId(out pid);
                }
                catch { }

                float peak = 0;
                try
                {
                    var meter = ctrl as IAudioMeterInformation;
                    if (meter != null) meter.GetPeakValue(out peak);
                }
                catch { }

                list.Add(new SessionInfo { Pid = pid, Peak = peak, State = state });
            }
            return list.ToArray();
        }
    }
}
'@

Add-Type -TypeDefinition $code -Language CSharp | Out-Null

$rows = foreach ($s in [CorticoAudio.AudioSessionPeaks]::GetSessions()) {
  $p = Get-Process -Id $s.Pid -ErrorAction SilentlyContinue
  [pscustomobject]@{
    pid = $s.Pid
    app = if ($p) { $p.ProcessName } else { '' }
    path = if ($p) { $p.Path } else { '' }
    peak = [math]::Round([double]$s.Peak, 4)
    state = $s.State
  }
}

@($rows) | ConvertTo-Json -Compress
