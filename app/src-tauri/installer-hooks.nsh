; Crux Hub installer hooks (Tauri NSIS).

; Before an install or update replaces files, and before an uninstall removes them: stop the hub if it runs from this
; install folder (its node.exe would be locked otherwise). runtime\stop-bundled-hub.mjs never touches a hub run from a
; clone. The app starts the hub again after an update. Hub data (~\.crux-hub, ~\crux, the downloaded Claude Code)
; lives outside this folder and is never removed.
; Inserted once in the install section and once in the uninstall section, so the label is unique in each.
!macro CRUX_STOP_BUNDLED_HUB
  IfFileExists "$INSTDIR\runtime\node\node.exe" 0 crux_stop_hub_done
  IfFileExists "$INSTDIR\runtime\stop-bundled-hub.mjs" 0 crux_stop_hub_done
  nsExec::ExecToLog '"$INSTDIR\runtime\node\node.exe" "$INSTDIR\runtime\stop-bundled-hub.mjs"'
  Pop $0   ; the exit code nsExec leaves on the stack
  crux_stop_hub_done:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CRUX_STOP_BUNDLED_HUB
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CRUX_STOP_BUNDLED_HUB
!macroend

; Uninstalling removes the start-at-sign-in entry the app adds on its first run (named after the product, see
; src/main.rs), and the note that it was added, so a reinstall turns it on again. A rehearsal build
; (tauri.rehearsal.conf.json) has its own product name and identifier, so it never touches the real app's entry.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  Delete "$APPDATA\${BUNDLEID}\autostart-set"
!macroend
