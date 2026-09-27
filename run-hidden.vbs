' 隐藏窗口启动器: 计划任务调用本文件, 无窗口启动 node login.mjs
' 自适应路径: 从本文件所在目录推导项目根; node.exe 路径优先读 install.ps1 生成的 node.path
Option Explicit
Dim sh, fso, baseDir, nodeExe, nodePathFile, f
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe = "node"                       ' 兜底: 依赖系统 PATH
nodePathFile = baseDir & "\node.path"
If fso.FileExists(nodePathFile) Then
  Set f = fso.OpenTextFile(nodePathFile, 1)
  If Not f.AtEndOfStream Then nodeExe = Trim(f.ReadLine)
  f.Close
  If Not fso.FileExists(nodeExe) Then nodeExe = "node"
End If

If Not fso.FolderExists(baseDir & "\logs") Then fso.CreateFolder(baseDir & "\logs")
sh.CurrentDirectory = baseDir
sh.Run """" & nodeExe & """ """ & baseDir & "\login.mjs""", 0, False
