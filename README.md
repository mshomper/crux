<p align="center"><img src="assets/crux-icon.svg" width="88" alt="Crux icon: a path splitting into three branches, one taken"></p>

<h1 align="center">Crux</h1>

<p align="center"><b>Find the crux. See the options. Make the call.</b></p>

---

Crux is a decision skill for Claude Code: it stops at the few choices that matter, shows you the options as pictures, waits for your pick, and keeps a record every later session reads. Crux Hub is a small chat app for running several Claude agents at once from your desk or your phone, built on the same decision records. Claude does the work around the decision. You make the call.

<p align="center"><img src="assets/hub-hero.png" alt="Crux Hub: a conversation with an agent, a decision card waiting for a pick, and the live strip of agents above" width="900"></p>


## Try the skill

1. Clone this repo: `git clone https://github.com/mshomper/crux.git` (or use GitHub Desktop).
2. Link or copy the `crux` and `crux-dig` folders into your Claude Code skills folder, `~/.claude/skills/` ([INSTALL.md](INSTALL.md) has the exact commands).
3. In a new Claude Code session, type `/crux quick` followed by a question, for example `/crux quick should presets live in the URL or a file?`

To see what the pages look like first, open [example/demo-decisions/index.html](example/demo-decisions/index.html) after cloning.

## Run the Hub

**Windows:** download `CruxHub_<version>_x64-setup.exe` from [GitHub Releases](https://github.com/mshomper/crux/releases/latest) and run it (per-user, no admin). It carries the Hub and its own Node, so there is no clone and no npm. A first-run screen asks for your own Anthropic API key and your project folders, then downloads the matching Claude Code from Anthropic (about 330 MB, once). Updates come from the tray icon, signed, from GitHub Releases; if you have 0.1.0, which had no updater, install the newest version by hand once. The installer is unsigned, so Windows may show "Windows protected your PC": choose More info, then Run anyway. Build it from source: [app/README.md](app/README.md).

**Mac, Linux, or from source:** you need Node 20 or newer, git, and your own Anthropic API key. The GitHub CLI (`gh`) and Tailscale are optional.

```bash
cd crux/hub
npm install
# PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."; $env:CRUX_HUB_USE_API_KEY = "1"
# Mac/Linux:   export ANTHROPIC_API_KEY=sk-ant-... CRUX_HUB_USE_API_KEY=1
npm start -- /path/to/your/project
```

Then open http://localhost:4747. API use is billed per token by Anthropic. The desktop app finds a Hub run this way and uses it.


## Learn more

- https://crux.notarobot-eng.com: what Crux and the Hub do, with pictures
- [INSTALL.md](INSTALL.md): installing the skill, every command, how the records work
- [hub/README.md](hub/README.md): the Hub in full, including phone access and permissions

## Status

Early software. Hub version 0.18, desktop app 0.2. Built and used on Windows first; Mac and Linux are untested. Made for one person, running on your own PC.

## License

[MIT](LICENSE)
