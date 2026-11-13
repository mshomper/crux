# Crux Hub desktop app (Windows)

One installer with everything in it (decisions 49, 52 and 54): the hub, its own Node, a window and a tray icon. Claude Code is not in the installer: the hub's first-run screen downloads the exact version it needs from Anthropic.

- **First run:** a setup screen asks for the Anthropic API key, the project folders, and downloads Claude Code (checked against the Agent SDK's checksum, kept in `~/.crux-hub/claude-code/<version>/`). Its X or Escape closes it without changing anything.
- **Sits on top of the hub:** the app starts the hub when it is down (`runtime/hub/restart.mjs`, with the app's own Node) and quitting it leaves the hub running, so the phone keeps working.
- **Close** (the X) hides the window to the tray. **Left-click** the tray icon to open it again.
- **Tray menu:** Install update x.y.z (only when one is ready), Open Crux Hub, Restart hub, Quit (the app only; the hub keeps running).
- **Updates:** checked a minute after launch and once a day against `latest.json` on GitHub Releases, verified with the updater's public key. Installing one stops the app's own hub, replaces the files and starts the new app, which starts the hub again. Settings, key and Claude Code live outside the install folder and stay.
- **One copy:** starting the app again brings the open window forward.
- **Start with Windows:** the installed app turns this on at its first run and starts hidden in the tray. Turn it off in Task Manager, Startup apps. Uninstalling removes it. Dev runs and the bare exe in `target/` never turn it on.
- The window remembers its size and place.
- The hub page gets no native access: no Tauri capability names its address, so neither the hub page nor anything an agent wrote can call the app. Links to other sites open in your browser.
- Not yet: PC notifications (a later step).

## What the installer holds

`app/scripts/stage.mjs` (run by `tauri build`) fills the git-ignored `app/staging/runtime/`, which Tauri bundles beside the exe as `runtime/`: `node/node.exe` (the build PC's Node), `hub/` (tracked files, no tests) with `npm ci --omit=optional` packages, so the Agent SDK comes without its 330 MB Claude Code program, `crux/` (the page builder), `stop-bundled-hub.mjs` (the installer runs it before replacing or removing files; it stops only a hub started from this install) and `THIRD-PARTY.md`. No `node_modules` or Anthropic file ever goes into the repo. About 29 MB to download, about 135 MB installed, plus about 330 MB of Claude Code on first run.

## Build and release

Needs Node, the Microsoft C++ Build Tools ("Desktop development with C++"), Rust (`rustup`, stable-msvc) and git.

```powershell
cd app
npm install
npm run release
```

`npm run release` stages the runtime, builds, signs the update with `%USERPROFILE%\.tauri\crux-hub-updater.key` (no password; keep a copy safe: without it installed apps can never update) and writes `app/release/CruxHub-<version>/`: `CruxHub_<version>_x64-setup.exe`, its `.sig` and `latest.json`. Publish all three as a GitHub release tagged `v<version>`; installed apps find it through `releases/latest/download/latest.json`. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json` first.

**Code signing:** none for now (decision 53 C), so Windows may warn on first run. When a certificate or signing service is chosen, it goes in `src-tauri/tauri.conf.json` as `bundle.windows.signCommand`; nothing else changes.

## Settings

Optional, in `~/crux/hub.json` (or `$CRUX_HOME/hub.json`): `{ "app": { "port": 4747, "hubDir": "C:/path/to/crux/hub" } }`. The hub folder is, in order: `hubDir`; the git clone the hub on that port was last started from (`~/.crux-hub/launch-<port>.json`), so an existing clone keeps running with no setup and no edit; the app's own hub (`runtime/hub`). Whichever runs, `restart.mjs` starts the hub the way it was last started on that port.

## Rehearsals

Never rehearse on port 4747. `src-tauri/tauri.rehearsal.conf.json` gives a build its own name and app id ("Crux Hub Rehearsal"), so it never meets a real install, and allows a plain-http update address. For a dev build set `TAURI_CONFIG` to that file's contents before `cargo build`; for an installer pass `--config src-tauri/tauri.rehearsal.conf.json` to `npm run release`. Start it with `CRUX_HUB_DATA` and `CRUX_HOME` in the temp folder (a `hub.json` there naming a test port), `CRUX_APP_NO_AUTOSTART=1` (no sign-in entry), and `CRUX_APP_UPDATE_URL` pointing at a local `latest.json` to rehearse an update. Install into a temp folder with `/S /D=<folder>` and remove it with its `uninstall.exe /S`.
