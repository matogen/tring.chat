# tring.chat — focus-centred terminal deck for agentic work

Date: 2026-09-03
Status: approved design, awaiting implementation plan

## 0. Changelog

**2026-09-14 — Browser agents.** A session can own a Playwright browser alongside its
shell (§4.7, §4.8, §5.13). Optional, off by default, and gated on a daemon-side
capability rather than a browser preference.

**A browser is an attachment to a session, not a kind of session.** This is the whole
design and everything else follows from it. A running PTY cannot be converted into a
browser, so if the choice is to be offered on *every* tile — including the fifteen
already running — it cannot mean "which process do I launch". It means "does this slot
also own a page". Attaching starts a `BrowserContext`; detaching closes it; the shell
runs untouched through both. No kill, no confirmation, no lost scrollback.

`SessionInfo` therefore gains `browser: BrowserInfo | null`, **not** a `kind` enum. A
session is always a shell and may additionally have a page, and a two-valued `kind` would
misdescribe that the moment anything else is attachable. The dialogs still present it as
a binary choice — *Terminal* or *Browser Agent* — because that is what the user is
deciding; the model underneath stays honest.

A slot holding a browser renders as a split: terminal on one side, live page on the
other. The agent drives the page through tools scoped to *its own* page via
`TRING_SESSION_ID`, so the agent in slot 7 drives the browser in slot 7 — nothing to wire
up and no way for two agents to contend for one page. Telling the agent what to do needs
no new interface at all: it is Claude Code in the left pane and you type at it as you
already do.

**Scoped by session id, not a browser id**, and that follows from attachment rather than
being a preference. A shell's environment is fixed when it spawns, and attaching happens
long afterwards — often to a session that has been running for an hour — so a
`TRING_BROWSER_ID` could never reach the process that needs it. `TRING_SESSION_ID` is
already there, already unique, and already identifies the slot that owns the page.

Two drivers share one page, so control is explicit and visible (§4.7). The human takes
the wheel by touching the page and returns it with a button; the agent's tools **block
rather than error** while the human holds it, because an erroring tool makes an agent
retry-loop against a wall.

The case that justifies the feature is the login wall. An agent that hits SSO, a captcha
or 2FA times out on a selector — an explicit "blocked on a human", far better than the
shell's idle guess — the tile goes green and notable, and the human types the password
with their own hands. Those keystrokes go through CDP into the page. They never pass
through a tool call, so the credential is not in the agent's transcript, not in its
context window and not in any log tring keeps. Every headless agent-browser makes you
either paste the credential into the model's context or pre-seed a `storageState`. This
property exists *only* because the browser is visible and interactive, and it is the
argument for the split over a background browser with tools.

Chromium is ~150MB and is not an npm dependency. It is fetched lazily on first enable,
never at install time (§6): the install story already carries node-gyp on Linux and will
not also carry a browser download.

**2026-09-11 — Phone view.** Below 720px the ring is not drawn and a switcher bar
(§5.11) takes its place: the focused session's slot, name and status, a tap to open the
picker, a tap to the next finished session. The picker becomes a bottom sheet with 44px
rows and two buttons standing in for its key legend. Nothing changes on the daemon or in
the protocol; the daemon still owns sixteen slots per project.
**2026-09-11 — Installable.** A web app manifest, icons and a passthrough service worker
(§5.12) make tring a progressive web app. The bearer token is remembered in
`localStorage` on the first visit so the installed app can start from a bare URL.

**2026-09-04 — Claude usage view.** An optional non-terminal view (§4.5, §5.6, §5.10)
reporting what Claude Code has spent. It is a **view mode, not a project**: no slots, no
root, no shells, nothing persisted by `ProjectManager`. `GET /api/usage` serves it; the
pinned tab swaps `#ring` for the panel.

Two sources, because neither is sufficient alone:

- **The real limits come from Claude Code itself.** `claude -p "/usage"
  --output-format json` returns the live session and weekly percentages with their reset
  times. The CLI answers it locally — the run reports zero turns, zero cost and zero API
  time — so it is a local question, not a billed one. Nothing on disk records this:
  `stats-cache.json` holds message counts with no tokens, `.credentials.json` holds a
  plan name with no counters, and no transcript carries a rate-limit field. The only
  alternative would be reading the user's OAuth token and calling an undocumented
  endpoint, which a terminal deck distributed on npm should not do.
- **Tokens, cost and the per-project split come from the transcripts**, which `/usage`
  does not break down by repository.

When `claude` is not on the daemon's PATH the panel reports the transcript numbers alone
and says why there is no percentage. There is no budget setting: a bar needs a real
ceiling, and an invented one is worse than none.

**2026-09-04 — tile names and colours.** A tile carries an optional user colour
(§5.2, §5.9) alongside its name, both editable from a right-click or the picker's `r`.
`SessionInfo` gains `color`, the protocol gains one `color` message, and
`projects.json` persists it beside the name. The colour renders as a ring outside the
status border rather than replacing it, and the twelve choices — four hues in three
tiers — avoid green, amber and red so §5.1's reserved-signal rule survives contact with
a user's colour picker. The value
reaches a CSS custom property, so `SessionManager.setColor` rejects anything that is
not `#rrggbb`.

**2026-09-04 — ring size.** The number of terminals around the focus is a setting
(§5.2, §5.6): 4, 8, 12 or 16. Twelve and sixteen are rings — the perimeter of an N×N
grid; four and eight are bands, a top row and a bottom row with the focus spanning
the full width, because below twelve a ring's side columns cost the centre more
width than the tiles are worth.

The daemon is untouched: it still owns sixteen slots per project, and ring size is a
per-browser display preference in `localStorage` beside the sound toggle. Every
`create` names its slot explicitly, so nothing about it crosses the wire.

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
| Browser agents | Optional. A Playwright `BrowserContext` **attaches to** an existing session rather than replacing it, so every tile can offer the choice without killing anything (§4.7) |
| Browser control | One page, two possible drivers. The wheel is explicit and shown; the human grabs it by touching the page, the agent's tools block while they hold it (§4.7) |
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
    src/browser.ts             Playwright lifecycle: shared browser, per-session context, screencast (§4.7)
    src/browser-control.ts     the wheel: who drives, grab/release, agent gating (§4.7)
    src/browser-tools.ts       MCP endpoint; tools scoped to the caller's own context (§4.8)
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
    src/browser-pane.ts        the split half: screencast frames, input forwarding, control header (§5.13)
    src/picker.ts              Ctrl+Space overlay, key handling, next-done cycling
    src/new-session-dialog.ts  cwd, optional command, optional name
    index.html, style.css
  docs/superpowers/specs/      this document
```

Runtime dependencies: `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `ws`,
`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `@fontsource/inter`,
`@fontsource/jetbrains-mono`.
Optional: `playwright-core` — an `optionalDependency`, resolved lazily at first enable and
absent from every code path that does not touch §4.7. `playwright-core` rather than
`playwright` because the latter's install hook downloads browsers, which §6 forbids.
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
- A session may additionally own a page (§4.7), held as `browser: AttachedBrowser | null`,
  so the PTY half of this section is unchanged whether one is attached or not. **No new
  environment variable**: a shell's environment is fixed at spawn and attachment happens
  afterwards, so `TRING_SESSION_ID` — already injected, already unique — is what scopes an
  agent's browser tools to its own page.

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
- `settle(now)` is the one entry point that does not come from the byte stream: an
  attached page that has stopped loading (§4.7). It needs to exist because `tick` gates on
  PTY output, which a session working only in its browser never produces, while every
  explicit signal (`commandEnd`, `bell`, `hook`) declares itself notable and a page load is
  not news. It earns the right to ring by the same rule the idle path uses — sustained work
  first — so `tick` is now written in terms of it.

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
      "browser": { "enabled": true, "allow": ["localhost:*", "*.staging.example.com"], "eval": false },
      "sessions": [
        { "slot": 1, "name": "server", "cwd": "/home/dev/api-service", "command": "npm run dev" },
        { "slot": 2, "name": null,     "cwd": "/home/dev/api-service", "command": null,
          "browser": { "url": "https://app.staging.example.com/login" } }
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
- A recorded `browser` **is** reattached on respawn, and its last URL reopened. This is the
  opposite of the `command` rule above and deliberately so: a re-run command executes work,
  where a reattached browser restores a view. The profile is on disk either way (§4.7), so
  the alternative is a logged-in session the user has to go and re-open by hand, having
  already told us they wanted it. It obeys the allowlist like any other navigation, so a
  URL that is no longer permitted opens blank rather than prompting at startup.
- Scrollback is not restored. See §8.

### 4.4 WebSocket protocol

One socket per browser tab. Each socket tracks its own active project and its own focused
session id, so two tabs can sit in different projects.

Client → server:
`hello{token?}`, `focus{id|null, cols, rows}`, `input{id, data}`, `resize{cols, rows}`,
`create{projectId?, slot?, cwd, command?, name?, browser?, url?}`, `kill{id}`,
`rename{id, name}`, `ack{id}`, `respawn{id}`, `activateProject{projectId}`,
`createProject{name, root}`, `renameProject{projectId, name}`, `deleteProject{projectId}`,
`attachBrowser{id, url?}`, `detachBrowser{id}`, `browserInput{id, event}`,
`browserGrab{id}`, `browserRelease{id}`, `browserNavigate{id, url|'back'|'forward'|'reload'}`.

Server → client:
`state{projects[], activeProjectId, capabilities}` on connect and on any structural
change, where each project carries its sessions and their statuses;
`status{id, status, since, title}` for any session in any project;
`output{id, data}` for the focused session only;
`screen{id, ansi}` full replay when focus changes;
`snapshot{id, rows}` throttled to at most 4 per second per session, sent only when the
visible buffer changed since the last snapshot, and **only for sessions in the socket's
active project**;
`frame{id, …}` one screencast frame, binary, same gating as `snapshot` (§4.7);
`browser{id, info}` url, title, control holder and load state changed;
`exit{id, code}`;
`error{message}`.

Output frames and screencast frames are binary WebSocket frames prefixed with the session
id; everything else is JSON. Both carry a one-byte channel tag after the id separator, so
PTY bytes and JPEG bytes are told apart without a second socket. The tag is on the wire
rather than inferred from the payload — a JPEG whose leading bytes happen to be printable
must never be writable into a terminal — and both halves of the app are built from
`packages/shared` together, so there is no version in which one side writes the tag and
the other does not expect it. A frame that ends at the separator carries no tag and is
dropped rather than assumed to be PTY.

`browserInput` carries a normalised `{kind: 'mouse'|'key'|'wheel', …}` rather than a raw
DOM event: the daemon forwards it to CDP, and a shape the daemon defines is one the daemon
can validate. See §4.7 for what it refuses.

### 4.5 HTTP

**Unchanged by projects.** Session ids are globally unique, so no path gains a project
segment and every hook already installed keeps working.

- Serves the built web bundle from `packages/web/dist`.
- `POST /api/sessions/:id/done` feeds `hook` into the tracker.
- `POST /api/sessions/:id/status` with `{status: "busy" | "done"}` for tools that want
  finer control.
- `GET /api/sessions` returns the state list, for scripts. Entries gain a `project` field.
- `GET /api/usage` returns a `UsageReport`: Claude Code's own limits plus a transcript
  scan (§5.10), gathered in parallel and memoised for 30s (~1.8s cold, ~1ms warm). **The handler is built once, not per request** — it holds that cache,
  and a fresh closure per request throws it away silently (502ms per call instead of
  0.8ms, with no error to notice).
- `GET /api/capabilities` returns `{browser: 'unavailable' | 'off' | 'on'}` (§4.7). Also
  inlined into the `state` message, because the UI needs it before it draws a tile and a
  second round trip would make the control flicker in.
- `POST /api/browser/install` fetches Chromium and streams progress as
  `{received, total}` lines. Refused when the capability is already `on`, so a double
  click cannot start two downloads.
- Default bind is 127.0.0.1. A bearer token is **required** by default, on loopback as
  much as off it — loopback is not an authentication boundary when the daemon spawns
  shells. One is generated on first run at `~/.config/tring/token` (mode `0600`) when
  `--token` is not given; `--insecure-no-token` turns it off and is refused off loopback.
  The same token covers HTTP, the WebSocket `hello` and the MCP endpoint of §4.8.

### 4.6 Claude Code integration

Optional, and **unchanged by projects**. A `Stop` hook in `~/.claude/settings.json` running

```
curl -s -X POST "$TRING_URL/api/sessions/$TRING_SESSION_ID/done"
```

turns the tile green the moment Claude ends its turn. The env vars are inherited from the
PTY, so the same hook config is correct in every session of every project. Without the
hook the tile still goes green after `idleMs` of silence. The README documents the snippet.

### 4.7 Browser sessions

Optional, off by default. A session may own a Playwright `BrowserContext`; the shell is
unaffected either way.

**Attachment, not kind.** `attachBrowser{id}` creates a context for an existing session and
`detachBrowser{id}` closes it, both while the PTY keeps running. This is what allows the
choice on every tile (§5.9, §5.13): a running shell cannot be reborn as a browser, so the
only non-destructive reading of "Terminal or Browser Agent" on a live session is
attach/detach. `SessionInfo.browser` is `BrowserInfo | null`, never a `kind` enum:

```ts
interface BrowserInfo {
  url: string
  title: string | null
  control: 'agent' | 'human'
  loading: boolean
  /** Set when the agent is parked on a selector a human probably needs to clear. */
  blockedOn: string | null
}
```

**One persistent context per project, one page per session.** Playwright offers either
isolated contexts (`newContext`, whose cookies die with them) or a persistent profile
(`launchPersistentContext`, which is one context per directory) — not both, so per-session
contexts and per-project persistence cannot coexist. Persistence is the half worth having:
logging into a staging environment once and finding every agent in that repository already
authenticated is the point of the feature, and isolating agents in the same project from
each other would mean logging in once per agent, which is the opposite of it. Pages within
the context are independent, so two agents still do not share a viewport.

Projects stay isolated from one another, which is the boundary that actually matters —
different repositories, different credentials. Each gets its own browser process, launched
on first attach and closed when its last page goes.

**Profiles live at `~/.config/tring/projects/<id>/browser/`**, so a login survives a
detach, a reattach and a daemon restart. Never the user's real Chrome profile: tring would
be handing an agent every cookie on the machine, and "use my existing logins" is a decision
that deserves its own explicit gesture rather than arriving as a side effect of attaching a
browser. Importing a `storageState` is that gesture, and is out of scope for the first
version.

**Whether Chromium is installed is answered from the filesystem, not from Playwright.**
`chromium.executablePath()` would be the obvious source, but importing `playwright-core`
costs ~400ms and this runs at every daemon start — a user who never enables the feature
would pay it every time, which §6 forbids. So the browser cache directory is inspected
directly. That couples tring to another package's on-disk layout, and the coupling is
bounded on purpose: a false negative offers a download that the idempotent installer then
completes in seconds, and a false positive fails at launch and says so. Neither breaks a
daemon that is only serving terminals. (`executablePath()` alone would not have sufficed
anyway — it answers with a path whether or not anything is there.)

**Frames come from CDP screencast**, not a `page.screenshot()` loop:
`Page.startScreencast{format: 'jpeg', quality, maxWidth, maxHeight}` pushes a frame only
when the page actually changes, which is the same property that makes §5.3 cheap — an idle
page costs nothing. Thumbnail subscribers get `maxWidth: 320, quality: 40`; a focused pane
re-subscribes at its own size. Frames are gated exactly like snapshots: active project
only, so a browser in a background project costs a live context and no pixels. Each frame
is acknowledged (`Page.screencastFrameAck`) before the next is requested, so a slow client
throttles the producer instead of queueing memory.

**Status** feeds the same `ActivityTracker` (§4.2), which needs no new states:

| Browser event | Tracker signal |
|---|---|
| navigation started, or an agent action begins | `busy` |
| `load` plus network quiet, no agent action pending | `done`, via `settle` (§4.2) |
| agent action times out on a selector, or a `dialog` opens | `done`, **notable**, `blockedOn` set |
| page crash, context closed unexpectedly | `exited` |

The third row is the one worth the feature. A Playwright action parked on a selector is an
*explicit* "a human is needed here" — the same class of signal as the Stop hook of §4.6, and
categorically better than the shell's idle guess, which cannot tell a finished agent from a
stuck one. It rings.

**Control: one page, two possible drivers.** Both the human and the agent can dispatch into
the same page, and simultaneous input corrupts form state and moves the DOM under whichever
of them is mid-action. So the wheel is explicit, single-valued and always rendered (§5.13):

- The human **grabs implicitly** — any `browserInput` takes the wheel. Taking control should
  be as fast as reaching for it, not a button to hunt for first.
- The human **releases explicitly**, with a button. Never on a timer: a timeout that returns
  control while someone is halfway through a login form is precisely the wrong behaviour,
  and the moments when a human holds the wheel longest are the moments it matters most.
- While the human holds it, the agent's tools **block and report "the human has control"**
  rather than erroring. An error makes an agent retry-loop against a wall, burning tokens
  and filling its context with failures; a block makes it wait, which is what a person in
  the same position would do.
- On release the agent is handed a fresh accessibility snapshot and "the human interacted;
  you are at `<url>`". It is **not** handed a keystroke log — that would put the password
  the human just typed by hand straight back into the transcript, undoing the one property
  (§0) this design exists to provide.

**Navigation is allowlisted per project.** `browser.allow` is a list of host patterns
defaulting to `["localhost:*", "127.0.0.1:*"]`; a navigation elsewhere is held and surfaced
on the tile as *allow once / always / deny*. An agent with a shell and an unrestricted
browser can put anything it has read into a URL, and blocking navigation is a real boundary
where hoping is not.

**The daemon's own origin is refused unconditionally**, allowlist or not. `tring` serves a
page that drives every terminal on the machine and hands it a bearer token in a query
parameter; an agent that browses to `http://127.0.0.1:7331/?token=…` is typing into its
own ring. The WebSocket origin check cannot catch this, because that request's origin is
genuinely the daemon's.

Also refused: `file://` and every other non-http(s) scheme, and downloads
(`acceptDownloads: false`). `browserInput` is validated against the normalised shape of
§4.4 — coordinates inside the viewport, key events carrying no modifiers the pane did not
send — because it arrives from the page and lands in CDP.

**What the allowlist is and is not.** It governs *navigation*, in every frame including
redirects and iframes, and only main-frame refusals are offered to the user — prompting for
each third-party iframe would train someone to click allow. It does **not** govern
subresource loads: an allowed page may fetch from a CDN, and an `img` or `fetch` to an
arbitrary host still leaves. So it raises the cost of exfiltration without making it
impossible, and calling it a seal would be a lie that someone later relies on. It is the
reason `browser_eval` is off by default (§4.8): a page that can run arbitrary script routes
around navigation entirely with one `fetch`.

### 4.8 Browser tools

How an agent drives its page. An MCP endpoint at `/mcp`, authenticated with the same token
as everything else (§4.5), which an in-session agent already has as `$TRING_TOKEN` — so
configuring it requires nothing pasted into a settings file.

**Tools are scoped to the caller's own page.** The MCP session resolves
`TRING_SESSION_ID` from the calling process's environment and looks up that session's
attached page; there is no tool taking a session or browser id, so an agent cannot address
a page that is not its own. This is what makes "the agent in slot 7 drives the browser in
slot 7" true by construction rather than by convention.

| Tool | Notes |
|---|---|
| `browser_navigate{url}` | Subject to the allowlist; a held navigation returns "waiting for the human to allow this" |
| `browser_snapshot{}` | The accessibility tree, not pixels. This is what a model steers with; screenshots are for the human |
| `browser_click{ref}` / `browser_type{ref, text}` / `browser_select{ref, value}` | `ref` comes from the last snapshot |
| `browser_wait{for, timeout}` | A timeout sets `blockedOn` and rings, rather than merely failing |
| `browser_eval{js}` | Off unless `browser.eval` is enabled per project — it routes around the allowlist trivially (`fetch`) |

Every tool returns "the human has control, waiting" and blocks while the wheel is held
(§4.7). `browser_snapshot` is the exception and always answers: reading the page cannot
collide with a human typing into it, and refusing it would leave an agent that has just
been handed control unable to see what it was handed.

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

Full-viewport column: a fixed 36px project tab bar, then a CSS grid filling the rest,
sized by the chosen ring. Slots are numbered clockwise from the top-left in every case,
and each shows: key legend, name or title, cwd basename, status border, the canvas, and
— when one is set — a user colour as a ring outside the status border. The name is also
drawn large and faded in the centre of the tile, scaled to the tile's size. While the
session is `done`, a mint circle carrying the slot number sits above that name, so the
key to press is the biggest thing on a finished tile. While it is `busy`, the canvas and
the centred name are dimmed and desaturated as well as amber-bordered, so the finished
tiles are the bright ones.

| Slots | Grid | Focus cell | Shape |
|---|---|---|---|
| 4 | 2 × 3, rows `1fr 3fr 1fr` | `2 / 1 / 3 / 3` | band |
| 8 | 4 × 3, rows `1fr 3fr 1fr` | `2 / 1 / 3 / 5` | band |
| 12 | 4 × 4 | `2 / 2 / 4 / 4` | ring |
| 16 | 5 × 5 | `2 / 2 / 5 / 5` | ring |

`layoutFor(size)` is pure and returns the grid templates, the focus `grid-area` and a
slot→cell map; the DOM half is a separate call, so the geometry is unit-tested without
a browser.

A tile is built once and repainted often, and the split is load-bearing: `renderRing`
rebuilds only when the slot layout changes, so a thumbnail's canvas is never pulled out
from under it, and *everything* mutable — name, window title, cwd, tooltip, status,
colour, the restart button — is written by `paintTile` instead. Anything drawn inside
`renderRing` that can change while a session keeps its slot is stale by construction.

The ring the client draws is the chosen size grown to fit: if the viewed project holds a
session in a higher slot — a restored project arriving with slot 13 occupied long after
you picked 8 — the ring renders at the smallest size that shows it, and shrinking says so
rather than taking effect. A running session that renders nowhere would still ring and
still count in the tab badge, which is the one outcome worth code to make impossible.

An empty slot is a dim "+ new session" placeholder that opens the new-session dialog with
the cwd pre-filled to the project root. When the browser capability is `on` (§4.7) that
dialog leads with the *Terminal / Browser Agent* choice; when it is not, the choice is not
rendered at all rather than shown disabled, because a control that can never be used is
worse than an absent one.

The focus cell holds one session's view. For a session with a browser attached it splits in
two — terminal and page (§5.13) — and the split belongs to the *cell*, not to the ring
geometry above, which is unchanged.

### 5.3 Thumbnails

One `<canvas>` per slot. On each `snapshot` message the canvas is repainted with a
monospace font at whatever size makes `cols × charWidth` fit the tile width, honouring
`devicePixelRatio`. Nothing is drawn between snapshots, so 16 busy sessions cost at most
64 small repaints per second. Only the active project's sessions send snapshots, so this
ceiling does not scale with project count.

The change gate that makes this cheap belongs to the *session*, not to any viewer:
`takeSnapshot()` returns null while the screen is unchanged. A shell sitting at its
prompt never changes again, so a client that attaches later — a reload, a second tab, a
project switch — would show a black tile forever. Two rules close that:

- **Attaching pushes the current screen once, ungated.** `hello` and `activateProject`
  send `snapshotNow()` for every session in the project the client is now viewing.
- **The client keeps the last screen per session id.** A ring rebuild discards the
  canvases and constructs new `Thumbnail`s, and a ring-size change involves no round
  trip at all, so without a client-side copy the tiles would blank until the next
  output.

A session with a browser attached draws **both halves, miniaturised, in fixed positions** —
the same split as the focus cell (§5.13), same orientation, same ratio. The tempting
alternative, showing whichever half is currently active, was rejected: a tile whose content
swaps underneath you costs more in recognition than it gains in detail. You do not *read* a
thumbnail, you recognise it, and a rendered page is distinguishable from a terminal at
100px on shape and colour alone — which is exactly the size where following the activity
would be indistinguishable from the tile having been replaced.

Screencast frames arrive as JPEG (§4.7) and are painted with `createImageBitmap` +
`drawImage` into the browser half; the terminal half is the existing cell-run paint,
unchanged. Both halves honour the one change-gate rule above.

### 5.4 Focus terminal

One xterm.js instance with the fit and webgl addons. On focus change: reset, write the
`screen` replay, attach to the live `output` stream, run fit, send `resize`.

Two rules keep the centre honest when you switch away, and breaking either leaves the
previous session painted over the new one:

- **The reset travels in the write queue, as RIS (`ESC c`).** `write()` is queued and
  parsed asynchronously while `reset()` is synchronous, so a plain `reset()` jumps the
  queue and whatever was already buffered flushes *afterwards* and repaints the terminal
  you just left. Heavy output — an agent rendering a diff — is exactly when the queue is
  deep enough for this to show.
- **The focus cell is never detached from `#ring`.** Rebuilding the ring replaces the
  tiles only. `replaceChildren(focusCell)` removes and re-inserts it, taking the live
  terminal's canvas out of the document, and re-attaching does not repaint — so the old
  session's pixels can survive the rebuild.

Switching projects restores the session you were last focused on there (`lastFocused`,
keyed by project id, resolved when that project's `state` arrives), rather than leaving
an empty centre. A custom key
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
| `b` | attach or detach a browser (§4.7); hidden while the capability is not `on` |
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
project dialog, and at the right a sound toggle and a settings gear.

Both marks are drawn to land on whole pixels at 1x, which is most of what "sharp" means
at this size: the logo uses explicit 5px cells rather than `1fr` (three `1fr` tracks
across 20px with 2px gaps is 5.333px a cell, so every square straddled a pixel), and the
SVGs render 1:1 with their 16-unit viewBox rather than being scaled to 14px. Each tab shows the project name and, when it has finished sessions, a
mint done-badge (`api-service ⬤3`). The active tab uses `--emerald`; badges use `--mint`.

Past overflow the bar scrolls horizontally (`overflow-x: auto`) with a tab `min-width`;
there is no cap and no warning. A developer with twelve projects open has a memory
problem, and the honest fix is `--scrollback`, not a UI that refuses.

The bar is never hidden. Its badges are the only way a finished agent in a background
project becomes visible, so 36px of permanent ambient signal is the point, not overhead.

### 5.7 Settings dialog

Opened by the gear in the bar. Ring size — four choices, the current one marked with
`--emerald` — then the Claude usage toggle (§5.10), then browser agents.

**Browser agents is a three-state control, not a checkbox**, because the middle state is
real: Chromium is not installed until someone asks for it (§6).

| Capability | Control |
|---|---|
| `unavailable` | *Install Chromium (~150 MB)* with a progress bar, streamed from `POST /api/browser/install` |
| `off` | A checkbox, unchecked |
| `on` | A checkbox, checked, above the project's allowlist |

Unlike ring size and the usage toggle — both per-browser `localStorage`, because both are
display choices — this one **lives on the daemon** in `projects.json` and is enforced
there. It spawns a browser process and stores cookies, so a second tab must not be able to
disagree with the first about whether that is allowed, and a client-side flag in front of a
server that would honour the request anyway is decoration.

### 5.8 Project dialog

Two fields: name and root directory, the root defaulting to the daemon's cwd. Shown
blocking on first run when no projects exist, and from the `+` button thereafter. The same
dialog, name field only, handles rename.

### 5.9 Session dialog

Opened by right-clicking a tile or pressing `r` in the picker — one dialog, not two, so
naming and colouring a tile are the same gesture. Name field, then thirteen swatches: no
colour, and four hues clear of the status palette in a light, a mid and a deep tier —
tiers rather than more hues, because the usable arc is about 150° wide and twelve hues
crammed into it are indistinguishable at 2px. The tint is an `outline` on the tile
and `.viewing` moves to an inset shadow, so status, colour and focus each own a ring and
none of them competes for the same pixels.

When the browser capability is `on`, the dialog also carries the *Terminal / Browser Agent*
control — the same segmented control as the new-session dialog, and the reason this is the
dialog that gets it: it is already the one gesture that edits a live session, reached from
a right-click or `r`, so the choice appears on **every** tile without a new affordance
anywhere. Changing it sends `attachBrowser` or `detachBrowser` (§4.7), not `create`; the
shell keeps running and there is nothing to confirm. `b` in the picker is the keyboard path
and toggles the same thing.

### 5.10 Usage view

Optional, off by default, enabled from the settings dialog. A pinned `Usage` tab in the
bar swaps `#ring` for a panel; anything that means "show me terminals" — a project tab, a
thumbnail click, the picker — swaps back. The daemon knows nothing about it beyond
serving `GET /api/usage`.

`readLimits()` spawns `claude -p "/usage" --output-format json` and parses the
`Current …: N% used · resets …` lines, anchored to the line start so the prose beneath
them ("69% of your usage was at >150k context") cannot be mistaken for a limit. It
resolves on the child's `exit` rather than on stdio close: something downstream of the
CLI holds a pipe open after the process is gone, and waiting for it costs 6.4s against
2.1s. A truncated read cannot pass silently, because it fails `JSON.parse`.

`scanUsage(dir, now)` reads `*.jsonl` under the transcript directory and buckets
`message.usage` into a live five-hour block, today, a rolling seven days, and a per-project
split keyed on each record's `cwd`. Two properties of the format are load-bearing and are
what the tests pin:

- **One message is written as one record per content block**, each echoing the same usage
  object — five records for one reply is ordinary. Summing records over-counts by roughly
  two, so messages are keyed by `message.id`.
- **A resumed or forked session replays earlier messages into a second file**, so that key
  is global rather than per-file.

The headline number is `input + output + cache_creation`. Cache reads are reported on
their own line and excluded from it: a representative week here was 1.49B cache reads
against 8.8M output tokens, so including them makes the bar 99% cache and tells you
nothing. Cost comes from a small model→price table that will drift, marked `ponytail:`.

A full scan of a year of transcripts (292 MB, 479 files) measures ~0.5s, and only files
whose mtime falls inside the week are opened, so no incremental offset tracking is
needed. Whether the tab is enabled, and whether it is the active view, live in `localStorage`
with the ring size and the sound toggle — reloading while the tab is open leaves you on
it. The daemon holds no view state.

Two display rules, both learned the hard way. `[hidden]` is declared once globally with
`!important`, because the UA rule loses to any author `display` — `#ring` and `#usage`
both carry `display: grid`, so `el.hidden = true` silently did nothing and the two views
split the screen. And only a real limit gets amber and red: a per-project bar is scaled
against the busiest project, so its top row is always 100% and would always look alarming
while meaning nothing of the sort.

### 5.11 Phone view

`(max-width: 720px)` — `MOBILE_QUERY` in `switcher.ts` — is the one breakpoint. Below it:

- **The ring is not drawn.** `#ring` becomes a block holding only the focus cell, and
  `.tile` is `display: none`. Tiles stay in the DOM: `renderRing` and `paintStatuses`
  are untouched, and a hidden canvas has zero width, which `Thumbnail.paint` already
  treats as "nothing to draw". Thumbnails were never readable at phone size, and the one
  terminal you can read wants every pixel.
- **A switcher bar sits under the project bar** (`#switcher`, rendered by
  `renderSwitcher`). Left, a button carrying the focused session's slot number, name and
  status with the status colour on its edge, exactly as a tile would show them; tapping
  it opens the picker. Right, a "next finished" button with the mint badge counting this
  project's finished sessions, disabled at zero. The count is per project because
  `nextDone` walks the viewed project's slots; the tab badges still carry the others.
- **The picker is the same picker, as a bottom sheet.** `#overlay` anchors the panel to
  the bottom edge, rows grow to 44px, and a `.picker-actions` row with "Next finished"
  and "New session" replaces the key legend, which is hidden. Both buttons call the same
  functions the `n` and `c` keys do.
- **The settings dialog hides ring size.** There is no ring to size; the choice is kept
  in `localStorage` for when the window is wide again.

`paintSwitcher` runs from `paintStatuses`, from the usage view's show/hide, and from the
media query's `change` event, which also refits the terminal — crossing the breakpoint
changes the terminal's size and what surrounds it in the same instant. The bar is
`hidden` whenever the query does not match or the usage view is up, so on desktop the
element costs nothing.

Reaching the daemon from a phone is a deployment question, not a UI one: it binds to
`127.0.0.1` by default, so `--host 0.0.0.0 --token <secret>` or a private network such
as Tailscale is needed. The README says so.
### 5.12 Installable app

`packages/web/public/` ships `manifest.webmanifest`, `sw.js` and `icons/`; Vite copies
them to the bundle root unchanged, and the daemon serves `.webmanifest` as
`application/manifest+json`, without which no browser offers to install. The manifest
declares `display: standalone`, the brand background and bar colours, and 192, 512 and
maskable 512 icons rasterised from the favicon mark; iOS reads `apple-touch-icon` and the
`apple-mobile-web-app-*` metas from `index.html` instead.

The service worker exists only so every browser counts the page as installable. It
passes every request straight through — a terminal deck has no offline mode worth having,
and caching `index.html` would pin a stale bundle across daemon upgrades. It is registered
in production builds only, so it never shadows Vite's dev server.

`resolveToken` in `token.ts` is what makes the installed app usable behind `--token`: the
manifest's `start_url` cannot carry a query string, so a token found on the URL is stored
under `tring.token` and read back on later starts. A token on the URL always wins, so a
rotated secret needs the link opened once more and nothing else.

### 5.13 Browser pane

The focus cell for a session with a browser attached, split in two: the xterm.js of §5.4
on one side, the live page on the other.

**The divider is draggable to either extreme**, and the ratio is remembered per session.
The focus cell is already competing with the ring for width, and halving it at 16 slots on
a laptop leaves a cramped terminal — so collapsing either half to nothing must not require
detaching the browser or changing the slot's kind. Sessions differ: one is a shell that
occasionally checks a page, another is a page with a shell attached, and the ratio is where
that is expressed. On a phone (§5.11) the two become tabs, not columns.

**The pane is a thin client.** It paints JPEG frames (§4.7) and forwards normalised mouse,
key and wheel events as `browserInput`. It does not run the page, hold a DOM, or know a URL
it was not told. This is the same division as the thumbnail — the daemon owns the truth and
the client owns the pixels — and it is what keeps the feature working over Tailscale and on
a phone, which a headed window on the daemon's machine would not.

**A header strip carries the wheel.** Back, forward, reload, the URL, and the control state
as words: *Agent driving* or *You're driving*, with a **Take control**/**Give back**
button. Never an icon alone. Two parties can act on this page and the question "who is
holding it right now" must be answerable from across the room, at a glance, without
hovering anything — it is the one piece of state that makes the difference between typing a
password into a form and typing it into a page an agent is mid-click on.

Touching the pane grabs the wheel (§4.7), so the button's usual job is handing it back.
While the human holds it, the pane is bordered in `--amber` and the agent's half shows what
it is waiting on; `blockedOn` renders there too, so "the agent is stuck on a login form" and
"you are driving" are one continuous story rather than two unrelated indicators.

## 6. Distribution

**v0.1: global npm package.** `npm i -g tring-chat`, then `tring`. The daemon starts, then
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

**Chromium is never an install-time cost.** `npm i -g tring-chat` must not grow a 150 MB
download, and on Linux it already asks for a build toolchain before it will finish at all
(§8) — a second, larger prerequisite on top of that is how an install stops being
attempted. So `playwright-core` is an `optionalDependency`, the browser is fetched only
when someone enables the feature (§5.7), and everything in §4.7 and §4.8 is behind a lazy
`import()` that never runs for a user who does not use it. A missing or half-downloaded
browser reports `unavailable` and offers the download again; it is never an error at
startup, and it never blocks the daemon from serving terminals.

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
- `browser`: the control machine of §4.7 is pure and clock-injected like `ActivityTracker`,
  so it is unit-tested without Playwright — a grab parks a pending agent action rather than
  failing it; a release resumes it; a second grab while the human already holds the wheel is
  a no-op. Navigation policy is pure too: the allowlist matcher, and the rule that the
  daemon's own origin is refused **even when the allowlist would admit it** — that one gets
  a test naming the `?token=` attack, because it is a rule a later refactor would otherwise
  see as redundant and fold away.
- Attach and detach are asserted to leave the PTY alive: the whole design rests on it, and
  a regression would present as "my scrollback vanished when I clicked a toggle".
- Playwright itself is exercised by one integration test behind a flag, skipped when no
  browser is installed, so `npm test` stays fast and passes on a machine that has never
  enabled the feature.
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
- **A browser context costs far more than a PTY.** A shell is a few MB; a Chromium context
  with a real page is tens to hundreds. The §8 rule that memory scales with total sessions
  holds, but the constant is much larger, and sixteen attached browsers is not a
  configuration the design pretends to serve well. `--scrollback` is no help here; detaching
  is. This is the reason browser-agent work tends to want an 8-slot ring, which the gear
  already offers — a documentation answer, not a code one.
- **A screencast is not a remote desktop.** JPEG frames and forwarded input are enough to
  log in, click through a consent screen and see what an agent is doing. They are not
  enough for video, WebGL, drag-and-drop with a file, or anything latency-sensitive, and
  the pane does not pretend otherwise. The escape hatch is launching the context headed on
  the daemon's machine, which is deliberately not the default because it forfeits the phone
  and Tailscale story that §5.13 exists to preserve.
- **The credential property of §0 depends on the human's keystrokes not being fed back to
  the agent.** It is preserved by a resync that sends an accessibility snapshot and nothing
  else, and the obvious "help the agent understand what just happened" improvement — a
  transcript of the handover — would quietly destroy it. Noted here because it will look
  like an oversight to someone who does not know why.

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
11. With Chromium not installed, confirm the settings dialog offers the download and that
    no tile shows a Terminal/Browser Agent control. Confirm the daemon starts, serves
    terminals and logs nothing about Playwright.
12. Install Chromium from the dialog. Confirm progress streams, the capability flips to
    `on` without a reload, and the control appears on every tile.
13. Attach a browser to a **running** session that has scrollback and a live process.
    Confirm the shell survives, the scrollback is intact, the cell splits, and detaching
    returns it to a full-width terminal with the process still running. This is the design's
    central claim and the one step that must not be skipped.
14. Run Claude Code in the terminal half and ask it to open a page and click something.
    Confirm the page moves, the tile is amber while it works, and the thumbnail shows both
    halves throughout.
15. Ask it to log in somewhere real. Confirm it parks on the form, the tile goes green and
    rings, and `blockedOn` is visible on the pane. Type the password by hand, hand control
    back, and confirm the agent continues — then confirm the password appears nowhere in
    the session transcript or the daemon log.
16. Ask the agent to navigate to a host outside the allowlist. Confirm it is held and
    prompted rather than blocked silently, and that the agent reports waiting rather than
    failing.
17. Ask the agent to navigate to the daemon's own URL with a token. Confirm it is refused
    outright and cannot be allowed from the prompt.
18. Switch to another project. Confirm frames stop for the background browser while its
    status still updates, matching the snapshot rule of §4.4.
19. Restart the daemon. Confirm attached browsers return with their profiles — a site you
    logged into in step 15 is still logged in — and that the shells respawn per §4.3.
