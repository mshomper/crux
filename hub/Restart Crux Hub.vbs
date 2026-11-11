' Restart Crux Hub: stops the hub on port 4747, starts it again with no window, and opens it.
' Double-click it, or make a desktop shortcut to it (see README.md, "Restart the hub").
' It runs restart.mjs, next to this file, with no console window. Arguments are passed on (--port 4752 --no-open).
Option Explicit
Dim fso, sh, here, rc, extra, a
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
extra = ""
For Each a In WScript.Arguments
  extra = extra & " """ & a & """"
Next
On Error Resume Next
rc = sh.Run("node """ & here & "\restart.mjs""" & extra, 0, True)
If Err.Number <> 0 Then
  MsgBox "Could not run Node.js, so the hub was not restarted." & vbCrLf & "Is Node.js installed?", vbExclamation, "Crux Hub"
ElseIf rc <> 0 Then
  MsgBox "The Crux hub did not come back." & vbCrLf & vbCrLf & "What it printed is in hub-4747.log, in the .crux-hub folder in your user folder.", vbExclamation, "Crux Hub"
End If
