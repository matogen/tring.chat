# tring.chat — focus-centred terminal deck for agentic work

Date: 2026-09-03
Status: approved design, awaiting implementation plan

## 0. Changelog

**2026-09-03 — projects, theme, distribution.** Amended in place; the pre-projects
version is in git history.

- **Projects** (§4.3, §4.4, §5.2, §5.6, §5.7). A project is `{name, root}`. Each owns its
  own 16 slots and its own picker. Sessions are now nested under a project everywhere:
  persistence moves from `sessions.json` to `projects.json`, and the layout gains a tab
  bar. Projects always exist — the first run creates one, and there is no un-projected
  mode.
- **Theme** (§5.1). Brand tokens lifted from the marketing site. Mint is reserved for the
  `done` signal and is not used as a general accent.
- **Distribution** (§6). Ships as a global npm package that launches a chromeless browser
  window. Electron later, wrapping the identical daemon.
- **Unchanged deliberately:** the HTTP API (§4.5) and the Claude Code Stop hook snippet
  (§4.6). Session ids stay globally unique, so hooks already installed keep working.
- Sections 6–8 of the previous version are now 7–9.

## 1. Problem and goal

Cobus runs many agent sessions in parallel: Claude Code, other coding agents, plain
shells. Working across them today means juggling terminal windows and losing track of
which agent has finished and is waiting for input.

tring.chat is a browser app that keeps **one terminal in focus** in the centre of the
screen and shows **up to 16 zoomed-out live thumbnails** around it. A thumbnail turns
green when its session has finished and is waiting. A prefix key (Ctrl+Space) opens a
picker; one keystroke moves any session into the centre. The session that was in the
centre returns to its own fixed slot, so positions never shuffle and muscle memory holds.

That ring belongs to a **project**: a name and a root directory. A developer can keep one
project with 16 terminals, or several projects — one per repository or worktree — each
with its own ring, switching between them from a tab bar. Sessions in projects you are not
looking at keep running, and their tab reports how many have finished.

Success looks like: 16 sessions running, the user typing in one, glancing at the ring to
see the others animating, and switching to a green one with two keystrokes.

## 2. Decisions

| Topic | Decision |
|---|---|
| Platform | Browser web app served by a local Node daemon |
| Stack | TypeScript end to end: Node + node-pty on the server, Vite + xterm.js in the browser, no UI framework |
| Distribution | Global npm package; the daemon opens a chromeless browser window. Electron later for a real installer, wrapping the same daemon (§6) |
| Workload | Tool-agnostic: any shell or agent. Claude Code gets optional extras, never a dependency |
| Done signal | Idle detection, OSC 133 shell prompt markers, Claude Code Stop hook, BEL. All four feed one state machine |
| Persistence | Daemon owns the PTYs and scrollback. Reloading the page loses nothing; a daemon restart respawns shells in the same projects, slots and cwds but loses scrollback |
| Projects | A project is `{name, root}` and owns 16 slots and its own picker. Projects always exist; first run creates one. No cap on project count |
| Background cost | Every PTY stays live and status-tracked in every project. Snapshot streaming runs only for the active project; background projects surface as a done-count on their tab |
| Layout | Fixed 36px project tab bar above a fixed ring: centre focus terminal plus 16 numbered slots. Empty slots are click-to-spawn placeholders |
| Switching sessions | Ctrl+Space prefix opens an overlay picker listing the active project's slots 1–16; non-busy sessions highlighted, busy ones dimmed but selectable |
| Switching projects | Click a tab, or `p` inside the picker. The slot keymap is untouched |
| Slot keys | `1`–`9`, `0` for slots 1–10; `Ctrl+1`–`Ctrl+6` and `Shift+1`–`Shift+6` for slots 11–16 (see §8) |
| Swap model | The centre is a view of one session. Focusing a session does not move it; the previously focused one simply stops being viewed |
| Thumbnails | Server keeps a headless terminal per session and streams throttled screen snapshots; thumbnails are cheap canvases. Only the centre is a real xterm.js instance |
| Theme | Brand tokens from the marketing site. Mint `#3ee9a4` is reserved for the `done` signal; chrome uses the darker greens. Fonts vendored, no CDN (§5.1) |
| Name | Repo `tring.chat`, package name `tring` |

## 3. Repository layout

npm workspaces, one repo.

```
tring.chat/
  package.json                 workspaces: packages/*; scripts: dev, build, start, test
  packages/shared/             protocol types and pure logic used by both sides
    src/protocol.ts            WebSocket message types, client→server and server→client
    src/status.ts              SessionStatus and the ActivityTracker state machine (pure, unit-tested)
    src/keymap.ts              picker keymap: slot ↔ key legend, single source of truth
  packages/server/             Node daemon
    src/index.ts               CLI entry: --port (7331) --host (127.0.0.1) --token --scrollback (5000)
    src/session.ts             one PTY + headless xterm + serialize addon + ActivityTracker
    src/session-manager.ts     16 slots within one project; create/kill/rename/respawn
    src/project-manager.ts     projects; active project, lazy respawn, projects.json persistence
    src/snapshot.ts            headless buffer → compact ScreenSnapshot
    src/ws.ts                  WebSocket hub: state fan-out, focused output stream, snapshots
    src/http.ts                serves the web build; REST endpoints for hooks
    src/open-window.ts         launches the chromeless browser window (§6)
  packages/web/                Vite + vanilla TypeScript
    src/main.ts                boot and wiring
    src/ws-client.ts           reconnecting typed WebSocket client
    src/theme.css              brand tokens, lifted from the marketing site (§5.1)
    src/xterm-theme.ts         xterm.js theme object: surfaces branded, ANSI 0–15 stock
    src/project-bar.ts         tab bar: tabs, done badges, overflow scroll, + button
    src/project-dialog.ts      create/rename project: name and root directory
    src/ring-layout.ts         5×5 CSS grid, centre spans 3×3, slots numbered clockwise
    src/thumbnail.ts           one <canvas> per slot, paints snapshots, status border
    src/focus-terminal.ts      the single xterm.js: fit + webgl addons, replay on switch
    src/picker.ts              Ctrl+Space overlay, key handling, next-done cycling
    src/new-session-dialog.ts  cwd, optional command, optional name
    index.html, style.css
  docs/superpowers/specs/      this document
```

Runtime dependencies: `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `ws`,
`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `@fontsource/inter`,
`@fontsource/jetbrains-mono`.
Dev: `vite`, `typescript`, `vitest`, `tsx`.

## 4. Server

### 4.1 Session

- Spawns `$SHELL` (or a user-supplied command) in the requested cwd with node-pty.
  Initial size 120×36; resized to the focus terminal's dimensions whenever a client
  focuses it.
- Injects environment: `TRING_SESSION_ID`, `TRING_SLOT`, `TRING_PROJECT`, `TRING_URL`.
  Anything running inside the session can call back to the daemon with these.
  `TRING_SESSION_ID` is globally unique across all projects, so it alone identifies a
  session; `TRING_PROJECT` is a convenience for shell prompts and status lines.
- Every PTY output chunk is written to a headless xterm (`@xterm/headless`, scrollback
  configurable, default 5000 lines) and, if some client has this session focused,
  forwarded to that client.
- Out-of-band signals are extracted from the same stream:
  - OSC 133 A/B/C/D (prompt start, prompt end, command start, command end) via
    `parser.registerOscHandler(133, …)`
  - OSC 0 and OSC 2 set the session title (Claude Code and most shells emit these)
  - BEL (0x07) marks the session done
- `serialize()` returns the full buffer including scrollback as ANSI, via the serialize
  addon. Used when a client focuses the session or reconnects.
- `snapshot()` returns the visible rows as run-length cells `{text, fg, bg, bold}` for
  thumbnails.

### 4.2 ActivityTracker (shared, pure)

States: `idle`, `busy`, `done`, `exited`.

```
idle  --(sustained output | OSC 133;C)-->  busy
busy  --(quiet for idleMs | OSC 133;D | BEL | hook)-->  done
done  --(focused AND input | explicit ack)-->  idle
any   --(PTY exit)-->  exited
```

- "Sustained output" means output continuing for at least 1.5 s, or at least 2 KB within
  the activity window. A single keystroke echo therefore never flips a session to busy.
- `idleMs` defaults to 3000 ms and is configurable.
- `done` is never entered directly from `idle`: if nothing happened there is nothing to
  report.
- Focusing alone does **not** clear `done`. The tile stays green until the user types
  into it, so a result can be read first. The picker also offers an explicit "mark seen".
- Claude Code works with idle detection alone because its spinner produces continuous
  output while working. The Stop hook makes the green transition exact instead of
  delayed by `idleMs`.
- `exited` carries the exit code. The tile turns red and offers respawn in place.
- The tracker runs for **every** session in every project, active or not. It reads the
  same byte stream the daemon is already consuming, so a background project costs one
  state machine per session and nothing else.

### 4.3 ProjectManager and SessionManager

**SessionManager** owns the 16 fixed slots of one project. `create({slot?, cwd, command?,
name?})` uses the first empty slot when none is given, and rejects when all 16 are full.
The cwd defaults to the project root.

**ProjectManager** owns the list of projects and which one is active.

- A project is `{id, name, root, slots}`. There is no cap on project count.
- Creating a project takes a name and a root directory. Renaming is supported; changing
  the root is not — a mis-rooted project is cheaper to delete and recreate.
- Deleting a project kills its sessions behind a confirmation that names the count.
  Deleting the last project returns to the first-run dialog, so there is one empty state,
  not two.
- Killing the last session in a project does **not** delete the project. It leaves 16
  empty-slot placeholders.
- State persists to `~/.config/tring/projects.json` on every change, replacing the
  previous `sessions.json`:

```jsonc
{
  "version": 1,
  "activeProjectId": "p_a1b2",
  "projects": [
    {
      "id": "p_a1b2",
      "name": "api-service",
      "root": "/home/dev/api-service",
      "sessions": [
        { "slot": 1, "name": "server", "cwd": "/home/dev/api-service", "command": "npm run dev" },
        { "slot": 2, "name": null,     "cwd": "/home/dev/api-service", "command": null }
      ]
    }
  ]
}
```

- **On daemon start**, every project returns with its tabs, slots, names and cwds. The
  **active** project respawns its sessions eagerly; other projects respawn on first
  activation. Four restored projects therefore cost 16 spawns at launch, not 64.
- Respawn starts a **plain shell** in the recorded cwd. The recorded `command` is kept and
  offered as a one-key re-run on the tile, never executed automatically — auto-running
  whatever was there last time is how four dev servers end up fighting over a port.
- Scrollback is not restored. See §8.

### 4.4 WebSocket protocol

One socket per browser tab. Each socket tracks its own active project and its own focused
session id, so two tabs can sit in different projects.

Client → server:
`hello{token?}`, `focus{id|null, cols, rows}`, `input{id, data}`, `resize{cols, rows}`,
`create{projectId?, slot?, cwd, command?, name?}`, `kill{id}`, `rename{id, name}`,
`ack{id}`, `respawn{id}`, `activateProject{projectId}`, `createProject{name, root}`,
`renameProject{projectId, name}`, `deleteProject{projectId}`.

Server → client:
`state{projects[], activeProjectId}` on connect and on any structural change, where each
project carries its sessions and their statuses;
`status{id, status, since, title}` for any session in any project;
`output{id, data}` for the focused session only;
`screen{id, ansi}` full replay when focus changes;
`snapshot{id, rows}` throttled to at most 4 per second per session, sent only when the
visible buffer changed since the last snapshot, and **only for sessions in the socket's
active project**;
`exit{id, code}`;
`error{message}`.

Output frames are binary WebSocket frames prefixed with the session id; everything else
is JSON.

### 4.5 HTTP

**Unchanged by projects.** Session ids are globally unique, so no path gains a project
segment and every hook already installed keeps working.

- Serves the built web bundle from `packages/web/dist`.
- `POST /api/sessions/:id/done` feeds `hook` into the tracker.
- `POST /api/sessions/:id/status` with `{status: "busy" | "done"}` for tools that want
  finer control.
- `GET /api/sessions` returns the state list, for scripts. Entries gain a `project` field.
- Default bind is 127.0.0.1, no auth. `--token` (or `TRING_TOKEN`) enables bearer auth on
  both HTTP and the WebSocket `hello`, for the case where the daemon is bound to a LAN
  address.

### 4.6 Claude Code integration

Optional, and **unchanged by projects**. A `Stop` hook in `~/.claude/settings.json` running

```
curl -s -X POST "$TRING_URL/api/sessions/$TRING_SESSION_ID/done"
```

turns the tile green the moment Claude ends its turn. The env vars are inherited from the
PTY, so the same hook config is correct in every session of every project. Without the
hook the tile still goes green after `idleMs` of silence. The README documents the snippet.

## 5. Web

### 5.1 Theme

Tokens are lifted from the marketing site (`tring-chat-marketing/index.html`) into
`theme.css` so the app and the site cannot drift:

```css
--bg:#040c0a; --bg-2:#071411; --panel:rgba(255,255,255,.028); --panel-2:rgba(255,255,255,.05);
--line:rgba(110,240,195,.11); --line-2:rgba(110,240,195,.2);
--text:#dceee7; --muted:#8aa79d; --dim:#5d7a71;
--mint:#3ee9a4; --emerald:#0fae7c; --deep:#0a3a2e;
--amber:#f5b642; --red:#f2545b;
--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--sans:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
```

**The reserved-signal rule.** `--mint` is used **only** for `done` status: green tile
borders, tab done-badges, the picker's finished entries. Chrome — buttons, focus rings,
active tab, hovers, the logo — uses `--deep` and `--emerald`. The marketing logo already
demonstrates the rule: eight `--deep` squares and one glowing `--mint` centre. Applied
across the UI it makes a finished agent the brightest thing on screen by construction,
which is the product's entire job.

Status colours follow from the tokens: `--dim` idle, `--amber` pulsing busy, `--mint`
done, `--red` exited.

**Terminal interior** (`xterm-theme.ts`): `background: --bg`, `foreground: --text`,
`cursor: --mint`, and **ANSI 0–15 left at xterm's defaults**. The ANSI palette is an API,
not decoration — `ls` colour-codes file types by it and `git diff` uses red and green.
Re-tinting it would make a red diff line arguable and could collide ANSI green (success)
with mint (agent done).

**Fonts** are vendored via `@fontsource/inter` and `@fontsource/jetbrains-mono` and bundled
by Vite. No CDN call: tring binds to 127.0.0.1 and a terminal deck is exactly what a
developer opens on a plane or a locked-down network.

**Logo** is the marketing site's 3×3 CSS mark reused verbatim at 20px at the left of the
tab bar; its SVG form is the favicon and the app icon.

### 5.2 Layout

Full-viewport column: a fixed 36px project tab bar, then a 5×5 CSS grid filling the rest.
The centre cell spans rows and columns 2–4 and holds the focus terminal. The 16 outer
cells are slots 1–16 numbered clockwise from top-left. Each slot shows: key legend, name
or title, cwd basename, status border, and the canvas.

An empty slot is a dim "+ new session" placeholder that opens the new-session dialog with
the cwd pre-filled to the project root.

### 5.3 Thumbnails

One `<canvas>` per slot. On each `snapshot` message the canvas is repainted with a
monospace font at whatever size makes `cols × charWidth` fit the tile width, honouring
`devicePixelRatio`. Nothing is drawn between snapshots, so 16 busy sessions cost at most
64 small repaints per second. Only the active project's sessions send snapshots, so this
ceiling does not scale with project count.

### 5.4 Focus terminal

One xterm.js instance with the fit and webgl addons. On focus change: reset, write the
`screen` replay, attach to the live `output` stream, run fit, send `resize`. A custom key
event handler swallows the prefix key and picker keys so they never reach the PTY. Clicking
a thumbnail focuses its session directly, without the picker.

### 5.5 Picker

**Per project.** Ctrl+Space toggles an overlay listing the active project's 16 slots with
status, name, and key legend. Sessions that are `done` or `idle` are highlighted; `busy`
ones are dimmed but still selectable. Keys inside the picker:

| Key | Action |
|---|---|
| `1`–`9`, `0` | focus slot 1–10 |
| `Ctrl+1`–`Ctrl+6`, `Shift+1`–`Shift+6` | focus slot 11–16 |
| `n` | focus the next `done` session clockwise from the current one |
| `Space` or `Ctrl+Space` | focus the previously focused session |
| `p` | list projects; a digit switches to one |
| `c` | new session dialog |
| `r` | rename focused session |
| `x` | kill focused session, with confirmation |
| `m` | mark focused session seen (`done` → `idle`) |
| `Esc` | close |

`p` is the only key projects add. `Ctrl+Tab` was rejected: it reads naturally with a tab
bar but is exactly the chord a host window may swallow, and the app-window mode of §6 is a
stepping stone to Electron.

The picker header and the document title show the count of `done` sessions **across all
projects**, e.g. `(3) tring`. The title's job is to reach the user when they are not
looking at tring, and at that moment only "something finished somewhere" matters; the
per-project breakdown is on the tabs, visible the instant they look back.

### 5.6 Project bar

Fixed 36px. Logo at the left, then one tab per project, then a `+` button opening the
project dialog. Each tab shows the project name and, when it has finished sessions, a
mint done-badge (`api-service ⬤3`). The active tab uses `--emerald`; badges use `--mint`.

Past overflow the bar scrolls horizontally (`overflow-x: auto`) with a tab `min-width`;
there is no cap and no warning. A developer with twelve projects open has a memory
problem, and the honest fix is `--scrollback`, not a UI that refuses.

The bar is never hidden. Its badges are the only way a finished agent in a background
project becomes visible, so 36px of permanent ambient signal is the point, not overhead.

### 5.7 Project dialog

Two fields: name and root directory, the root defaulting to the daemon's cwd. Shown
blocking on first run when no projects exist, and from the `+` button thereafter. The same
dialog, name field only, handles rename.

## 6. Distribution

**v0.1: global npm package.** `npm i -g tring`, then `tring`. The daemon starts, then
`open-window.ts` launches a chromeless browser window (`--app=http://127.0.0.1:7331`)
rather than a tab. This costs a few lines over opening a normal tab and buys the keyboard:
in an app window Chrome does not reserve `Ctrl+1`–`Ctrl+8` for tab switching, so slots
11–16 get their natural keys. The `Shift+digit` fallback of §8 remains for anyone opening
the URL in an ordinary tab.

**Later: Electron**, for a real installer with no Node prerequisite. It is a *wrapper*, not
a rewrite — Electron has Node built in, so the daemon becomes its main process and the Vite
bundle is what it renders. Electron over Tauri despite the size: Tauri's backend is Rust,
so a Node daemon would ship as a sidecar anyway, giving back most of the size advantage.

Electron is **not** a performance decision. It is Chromium — the same renderer, canvas and
WebGL the browser already provides — and all the expensive work (node-pty, headless
mirrors, `serialize()`, the trackers) is in the daemon either way.

**The one rule that keeps this reversible:** `packages/web` talks to the daemon only over
the WebSocket and HTTP protocols in §4.4 and §4.5, never assumes a browser, and never
hardcodes the origin. Nothing else needs to be built for the Electron move.

## 7. Testing

- `shared`: vitest for ActivityTracker — keystroke echo stays `idle`; sustained output goes
  `busy` then `done` after `idleMs`; OSC 133;D, BEL, and hook go `done` immediately; focus
  alone keeps `done`; focus plus input clears it; exit from any state. Keymap tests.
- `server`: vitest for `snapshot.ts` (known ANSI in, expected runs out); `project-manager.ts`
  round-trips `projects.json`, restores the active project eagerly and others lazily, and
  never auto-runs a recorded `command`; and one integration test that spawns a real session
  running `printf` and `sleep`, connects over the WebSocket protocol, and asserts the status
  transitions and the replay on focus.
- One test asserts snapshots are **not** emitted for sessions outside the socket's active
  project while their statuses still are. This is the whole background-cost decision, so it
  is the one that must not silently regress.
- `web`: strict TypeScript build. Behaviour is verified manually per §9.

## 8. Known constraints

- Chrome and Firefox reserve Ctrl+1 through Ctrl+8 for tab switching and pages cannot
  intercept them. Ctrl+digit for slots 11–16 works in the app window of §6 and in an
  installed PWA, but not in an ordinary browser tab. Shift+digit is the guaranteed
  fallback and is matched on `event.code` (Digit1–6) so it is keyboard-layout independent.
  Both are printed on the tiles. The keymap is one object in `shared/keymap.ts`.
- Chrome allows roughly 16 WebGL contexts per page. Only the focus terminal uses WebGL;
  thumbnails are plain 2D canvases.
- **Daemon restart loses scrollback, in every project.** Projects, slots, names and cwds
  all return and the rings look identical, but the history in each terminal is gone. The
  buffer lives in daemon memory; persisting dozens of sessions × 5000 lines continuously
  to disk is a different product. This is the one part of "reopen and everything is as I
  left it" the design does not deliver, and it is accepted deliberately.
- **Memory scales with total sessions, not with what is visible.** Every session in every
  project keeps a headless mirror, so four full projects is ~64 mirrors × `--scrollback`
  lines. CPU does not scale this way, because snapshots are active-project only. The
  `--scrollback` flag (default 5000) is the valve.
- Ctrl+Space may be claimed by an input method or window manager. The prefix key is
  configurable in the same keymap object.

## 9. Verification

1. `npm test` passes in `shared` and `server`.
2. `npm run dev`. An app window opens on `http://127.0.0.1:7331` and, with no config
   present, blocks on the project dialog. Create a project and confirm the ring appears
   with 16 placeholders and one tab.
3. Create three sessions in different cwds; confirm each new-session dialog pre-fills the
   project root.
4. In one, run `sleep 5 && echo hi`. The tile is amber during the sleep and green about
   3 s after the echo. Ctrl+Space then `n` jumps to it. Typing clears the green.
5. Run Claude Code in another session and ask it something. The thumbnail animates while it
   works and turns green when it stops, both with and without the Stop hook installed.
   Confirm the hook snippet from §4.6 works unmodified.
6. Reload the page. Projects, sessions, scrollback, and statuses are intact. Switching
   sessions replays the full screen and keystrokes reach the right PTY.
7. Create a second project with `+`. Start a long job in it, switch back to the first via
   `p`, and confirm the second project's tab shows a mint done-badge when the job finishes
   while its ring is not visible.
8. Fill all 16 slots in the active project and confirm the page stays responsive.
9. Restart the daemon with four projects saved. Confirm all four tabs return with their
   slots, names and cwds; that only the active project's shells spawn immediately; that a
   recorded `command` is offered rather than executed; and that scrollback is empty.
10. Confirm `--mint` appears nowhere in the UI except done-status affordances, and that
    `git diff` and `ls` render in normal ANSI colours inside the terminal.
