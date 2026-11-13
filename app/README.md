# Crux Hub desktop app (Windows)

A window and a tray icon on top of the hub (decision 49). The app does not own the hub: it shows the live hub at http://crux.localhost:4747 and, if the hub is not running when the app starts, starts it the usual way (`hub/restart.mjs --no-open`). Quitting the app leaves the hub running, so the phone keeps working.

- **Close** (the X) hides the window to the tray. **Left-click** the tray icon to open it again.
- **Tray menu:** Open Crux Hub, Restart hub (the same restart as `Restart Crux Hub.vbs`), Quit (the app only; the hub keeps running).
- **One copy:** starting the app again brings the open window forward.
- **Start with Windows:** the installed app turns this on at its first run and starts hidden in the tray. Turn it off in Task Manager, Startup apps. Uninstalling removes it. Dev runs and the bare exe in `target/` never turn it on.
- The window remembers its size and place.
- The hub page gets no native access: no Tauri capability names its address, so neither the hub page nor anything an agent wrote can call the app. Links to other sites open in your browser.
- Not yet: PC notifications (a later step).

## Build

Needs Node, the Microsoft C++ Build Tools ("Desktop development with C++") and Rust (`rustup`, stable-msvc).

```powershell
cd app
npm install
npm run tauri build
```

Output: `src-tauri/target/release/crux-hub.exe` and the installer `src-tauri/target/release/bundle/nsis/Crux Hub_<version>_x64-setup.exe` (installs for your user only, no admin).

## Settings

Optional, in `~/crux/hub.json` (or `$CRUX_HOME/hub.json`): `{ "app": { "port": 4747, "hubDir": "C:/path/to/crux/hub" } }`. Without `hubDir`, the app uses the folder of the hub as it was last started on that port (`~/.crux-hub/launch-<port>.json`), then the clone the app was built from.

To try a build against a test hub, start one on another port with its data in the temp folder (`CRUX_HUB_DATA`, `--no-agents`), and start the app with `CRUX_HOME` pointing at a folder whose `hub.json` names that port.
