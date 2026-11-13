; Crux Hub installer hooks (Tauri NSIS).
; Uninstalling removes the start-at-sign-in entry the app adds on its first run (AUTOSTART_NAME in src/main.rs),
; and the note that it was added, so a reinstall turns it on again.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Crux Hub"
  Delete "$APPDATA\dev.crux.hub\autostart-set"
!macroend
