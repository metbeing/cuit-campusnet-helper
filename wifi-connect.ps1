# 按 WiFi 配置文件名直接发起连接(不枚举网络列表, 不依赖位置服务)
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File wifi-connect.ps1 -Name Cuit_WiFi
param([Parameter(Mandatory=$true)][string]$Name)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WlanApi {
  [DllImport("wlanapi.dll")]
  public static extern int WlanOpenHandle(uint dwClientVersion, IntPtr pReserved, out uint pdwNegotiatedVersion, out IntPtr phClientHandle);
  [DllImport("wlanapi.dll")]
  public static extern int WlanCloseHandle(IntPtr hClientHandle, IntPtr pReserved);
  [DllImport("wlanapi.dll")]
  public static extern int WlanEnumInterfaces(IntPtr hClientHandle, IntPtr pReserved, out IntPtr ppInterfaceList);
  [DllImport("wlanapi.dll")]
  public static extern void WlanFreeMemory(IntPtr pMemory);
  [DllImport("wlanapi.dll")]
  public static extern int WlanConnect(IntPtr hClientHandle, ref Guid pInterfaceGuid, ref WLAN_CONNECTION_PARAMETERS pConnectionParameters, IntPtr pReserved);

  // WLAN_INTERFACE_INFO: GUID(16) + WCHAR[256](512) + int(4) = 532 字节
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct WLAN_CONNECTION_PARAMETERS {
    public int wlanConnectionMode;      // 0 = WLAN_CONNECTION_MODE_PROFILE
    [MarshalAs(UnmanagedType.LPWStr)] public string strProfile;
    public IntPtr pDot11Ssid;
    public IntPtr pDesiredBssidList;
    public int dot11BssType;            // 1 = Infrastructure, 3 = Any
    public uint dwFlags;
  }

  public static int ConnectFirst(string profileName) {
    uint ver; IntPtr h;
    int rc = WlanOpenHandle(2, IntPtr.Zero, out ver, out h);
    if (rc != 0) return -1000 + rc;
    try {
      IntPtr listPtr;
      rc = WlanEnumInterfaces(h, IntPtr.Zero, out listPtr);
      if (rc != 0) return -2000 + rc;
      try {
        int count = Marshal.ReadInt32(listPtr, 0);
        if (count < 1) return -3000;
        for (int i = 0; i < count; i++) {
          IntPtr info = new IntPtr(listPtr.ToInt64() + 8 + i * 532);
          Guid ifGuid = (Guid)Marshal.PtrToStructure(info, typeof(Guid));
          WLAN_CONNECTION_PARAMETERS p = new WLAN_CONNECTION_PARAMETERS();
          p.wlanConnectionMode = 0;           // 按配置文件名连接
          p.strProfile = profileName;
          p.pDot11Ssid = IntPtr.Zero;
          p.pDesiredBssidList = IntPtr.Zero;
          p.dot11BssType = 3;                 // 先试 ANY
          p.dwFlags = 0;
          rc = WlanConnect(h, ref ifGuid, ref p, IntPtr.Zero);
          if (rc == 87) {                     // ANY 不接受再试 Infrastructure
            p.dot11BssType = 1;
            rc = WlanConnect(h, ref ifGuid, ref p, IntPtr.Zero);
          }
          if (rc == 0) return 0;
        }
        return rc == 0 ? 0 : -4000 + rc;
      } finally { WlanFreeMemory(listPtr); }
    } finally { WlanCloseHandle(h, IntPtr.Zero); }
  }
}
"@

$rc = [WlanApi]::ConnectFirst($Name)
if ($rc -eq 0) { Write-Output "OK"; exit 0 }
Write-Output "CONNECT_FAIL:$rc"
exit 2
