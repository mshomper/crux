# Hub ideas (not decided)

## Live map of the orchestrator and workers (2026-11-11)

Matt's idea: a quick-to-read picture of who is doing what, like **lot-map**, with the centre drawn as a particle system like **particles.casberry.in**.

### References

- **lot-map** (https://github.com/alexeyw/lot-map, MIT). A Claude Code plugin that shows one session as a map:
  - a centre circle with a ring that fills as the context window fills (amber at 70%, red at 90%);
  - "stations" around the centre (Model, Files, Shell, Agents and so on);
  - a pulse flies out when a tool call starts and comes back when it ends;
  - spokes get thicker with use, so you can see where the work went;
  - subagents are small dots orbiting the Agents station;
  - errors turn red and stay red until your next message;
  - a feed underneath shows the last 16 actions.
- **AI Particle Simulator** (https://particles.casberry.in, from Casberry India). A WebGL particle tool:
  - formations such as sphere, nebula and helix;
  - physics modes: spring, boids flocking and fluid turbulence;
  - glow and trail effects;
  - it exports dependency-free WebGL2 or three.js code.
  - Licence and pricing aren't stated.
  - No Claude connector or MCP server is listed on the site or in the connector registry. The only link to Claude is "paste this prompt into Claude to generate particle code".

### How it could map onto the hub

The hub already streams everything a map needs over SSE (`agent_state`, `activity`, `approval`, `summary`, `message`, `pick`), so this is a view, not new plumbing.

- **Centre = the orchestrator role**, not one agent. The particle core is the role. Its ring is the holder's context %, and the handoff threshold (60%) is marked on it. At a handoff the swarm re-forms around holder #N+1, so the role continues even though the agent changes.
- **Stations = workers**, plus fixed stations for **You** and **the Board**.
  - A worker's state sets its look: working means a pulse, asleep means dim, retired means it fades out.
  - An `activity` event (Reading, Editing, Running) makes the worker's small orbit dots move.
- **Pulses carry messages along edges:**
  - `message_agent`: orchestrator to worker;
  - `post_summary`: worker to orchestrator;
  - `post_entry`: agent to the Board;
  - `pick`: You to the orchestrator.
- **Needs you = red**: a pending approval or open decision lights that station red until it's answered, like lot-map's red error dot. Clicking the station opens that thread's card.
- **Spokes thicken with traffic**, so after a day you can see which workers carried the project.

### Constraints to keep

- The page stays plain ES modules with no bundler. One standalone WebGL2 file for the core fits that, and a vendored three.js would too. Check casberry's licence before using any code it exports.
- House UI rules apply: no horizontal scrolling, drawn icons only, and the map must work at phone width.
- Respect `prefers-reduced-motion`: fall back to a static map with no particles.
- Particle count must stay modest; it's a sidebar or header, not the main view.
- Main-screen decision 0012 is threads / conversation / board on request. Where the map lives (a header strip, a toggle, or its own tab) needs a quick Crux decision before it's built.
