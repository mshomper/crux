# Profile template

Crux and the Crux hub can load what they know about you from a private folder, `~/crux/profile/`. This folder is a blank template for it. **Keep your real profile out of any public repo.** The best home for it is your home `crux` folder made into a private git repo, since Crux already writes the cross-project roll-up there.

```
~/crux/
  conventions.md        written by Crux: what all your projects have settled
  profile/
    core.md             every agent loads it: how you want work done and approved
    packs/_index.md     which pack each project folder uses
    packs/<project>.md  loaded only by agents working in that project
    private.md          people, contracts, personal details: read only when a task needs it
  media/                pictures agents posted to the hub (best left out of git)
```

How it grows:
- Hub agents record lessons with `propose_lesson`.
- Project lessons go straight into the project's pack.
- Lessons for `core.md` wait in the hub's Needs you until you add them.

Copy `core.md` and `packs/_index.md` from here to start.
