# Installing Crux on Windows

Crux is two skill folders, `crux` and `crux-dig`, placed where Claude Code looks for skills:

`C:\Users\<you>\.claude\skills\`

There are two ways to get them there. Pick one.

---

## Option 1: Linked to its own repo (recommended)

Crux lives in a repo under `Documents\GitHub` like your other projects. Claude Code's skills folder points at it, so pulling an update in GitHub Desktop updates the installed skill. Nothing to copy again.

**1. Clone the repo**
1. In GitHub Desktop: File, then Clone repository, and pick `mshomper/crux`.
2. Set the local path to `Documents\GitHub\crux` and clone.

**2. Link the skills folder to the repo**

Open PowerShell (no admin needed) and run these four lines:

```powershell
$repo   = "$env:USERPROFILE\Documents\GitHub\crux"
$skills = "$env:USERPROFILE\.claude\skills"
New-Item -ItemType Directory -Force -Path $skills | Out-Null
New-Item -ItemType Junction -Path "$skills\crux" -Target "$repo\crux"; New-Item -ItemType Junction -Path "$skills\crux-dig" -Target "$repo\crux-dig"
```

A junction is a folder shortcut that programs treat as the real folder. Deleting the junction later does not delete the repo.

**Updating:** pull in GitHub Desktop. Done.

---

## Option 2: Plain copy

1. Download this repo (or unzip `crux-kit.zip`).
2. Open `C:\Users\<you>\.claude\` in File Explorer. Create a `skills` folder inside it if there isn't one.
3. Copy the `crux` and `crux-dig` folders into `skills`.

**Updating:** replace both folders with the new versions.

---

## Check it works

1. Start a new Claude Code session in any repo. Skills load when a session starts.
2. Type `/crux` and it should appear in the command list, along with `/crux-dig`.
3. Try `/crux quick` with a small question. When you pick, Claude writes the record and builds `.decisions\index.html` in that repo.
4. The first time, Claude will offer to add one line to the repo's `CLAUDE.md`. Say yes so future sessions read the records before planning.

Node 18 or newer is needed for the page builder. Claude Code already requires it, so nothing extra to install.

## The all-projects page

After any decision, Crux refreshes `C:\Users\<you>\crux\index.html`, covering every repo under `Documents\GitHub` that has decisions. Bookmark it.

To scan more folders, or skip some, create `C:\Users\<you>\crux\config.json`:

```json
{
  "roots": ["C:\\Users\\<you>\\Documents\\GitHub", "D:\\Other\\Repos"],
  "ignore": ["old-experiments", "C:\\Users\\<you>\\Documents\\GitHub\\archive"]
}
```

`ignore` takes folder names (skipped wherever they appear) or full paths.

## Removing it

Delete `crux` and `crux-dig` from `C:\Users\<you>\.claude\skills\`. Your `.decisions` folders stay in each repo untouched.
