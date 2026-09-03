# tring.chat — focus-centred terminal deck for agentic work

Date: 2026-09-03
Status: approved design, awaiting implementation plan

## 1. Problem and goal

Cobus runs many agent sessions in parallel: Claude Code, other coding agents, plain
shells. Working across them today means juggling terminal windows and losing track of
which agent has finished and is waiting for input.

tring.chat is a browser app that keeps **one terminal in focus** in the centre of the
screen and shows **up to 16 zoomed-out live thumbnails** around it. A thumbnail turns
green when its session has finished and is waiting. A prefix key (Ctrl+Space) opens a
picker; one keystroke moves any session into the centre. The session that was in the
centre returns to its own fixed slot, so positions never shuffle and muscle memory holds.

Success looks like: 16 sessions running, the user typing in one, glancing at the ring to
see the others animating, and switching to a green one with two keystrokes.

## 2. Decisions

| Topic | Decision |
|---|---|
| Platform | Browser web app served by a local Node daemon |
| Stack | TypeScript end to end: Node + node-pty on the server, Vite + xterm.js in the browser, no UI framework |
| Workload | Tool-agnostic: any shell or agent. Claude Code gets optional extras, never a dependency |
| Done signal | Idle detection, OSC 133 shell prompt markers, Claude Code Stop hook, BEL. All four feed one state machine |
| Persistence | Daemon owns the PTYs and scrollback. Reloading the page loses nothing; a daemon restart respawns shells in the same cwds but loses scrollback |
| Layout | Fixed ring: centre focus terminal plus 16 numbered slots. Empty slots are click-to-spawn placeholders |
| Switching | Ctrl+Space prefix opens an overlay picker listing slots 1–16; non-busy sessions highlighted, busy ones dimmed but selectable |
| Slot keys | `1`–`9`, `0` for slots 1–10; `Ctrl+1`–`Ctrl+6` and `Shift+1`–`Shift+6` for slots 11–16 (see §7) |
| Swap model | The centre is a view of one session. Focusing a session does not move it; the previously focused one simply stops being viewed |
| Thumbnails | Server keeps a headless terminal per session and streams throttled screen snapshots; thumbnails are cheap canvases. Only the centre is a real xterm.js instance |
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
    src/index.ts               CLI entry: --port (7331) --host (127.0.0.1) --token
    src/session.ts             one PTY + headless xterm + serialize addon + ActivityTracker
    src/session-manager.ts     16 slots; create/kill/rename/respawn; metadata persistence
    src/snapshot.ts            headless buffer → compact ScreenSnapshot
    src/ws.ts                  WebSocket hub: state fan-out, focused output stream, snapshots
    src/http.ts                serves the web build; REST endpoints for hooks
  packages/web/                Vite + vanilla TypeScript
    src/main.ts                boot and wiring
    src/ws-client.ts           reconnecting typed WebSocket client
    src/ring-layout.ts         5×5 CSS grid, centre spans 3×3, slots numbered clockwise
    src/thumbnail.ts           one <canvas> per slot, paints snapshots, status border
    src/focus-terminal.ts      the single xterm.js: fit + webgl addons, replay on switch
    src/picker.ts              Ctrl+Space overlay, key handling, next-done cycling
    src/new-session-dialog.ts  cwd, optional command, optional name
    index.html, style.css
  docs/superpowers/specs/      this document
```

Runtime dependencies: `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `ws`,
`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`.
Dev: `vite`, `typescript`, `vitest`, `tsx`.

## 4. Server

### 4.1 Session

- Spawns `$SHELL` (or a user-supplied command) in the requested cwd with node-pty.
  Initial size 120×36; resized to the focus terminal's dimensions whenever a client
  focuses it.
- Injects environment: `TRING_SESSION_ID`, `TRING_SLOT`, `TRING_URL`. Anything running
  inside the session can call back to the daemon with these.
- Every PTY output chunk is written to a headless xterm (`@xterm/headless`, scrollback
  5000 lines) and, if some client has this session focused, forwarded to that client.
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

### 4.3 SessionManager

- 16 fixed slots. `create({slot?, cwd, command?, name?})` uses the first empty slot when
  none is given, and rejects when all 16 are full.
- Persists `{slot, name, cwd, command}` for each live session to
  `~/.config/tring/sessions.json` on every change. On daemon start, sessions are respawned
  from that file into the same slots and cwds. Scrollback is not restored; this is a
  documented limitation.

### 4.4 WebSocket protocol

One socket per browser tab. Each socket tracks its own focused session id, so two tabs can
focus different sessions.

Client → server:
`hello{token?}`, `focus{id|null, cols, rows}`, `input{id, data}`, `resize{cols, rows}`,
`create{slot?, cwd, command?, name?}`, `kill{id}`, `rename{id, name}`, `ack{id}`,
`respawn{id}`.

Server → client:
`state{sessions[]}` on connect and on any structural change;
`status{id, status, since, title}`;
`output{id, data}` for the focused session only;
`screen{id, ansi}` full replay when focus changes;
`snapshot{id, rows}` throttled to at most 4 per second per session and sent only when the
visible buffer changed since the last snapshot;
`exit{id, code}`;
`error{message}`.

Output frames are binary WebSocket frames prefixed with the session id; everything else
is JSON.

### 4.5 HTTP

- Serves the built web bundle from `packages/web/dist`.
- `POST /api/sessions/:id/done` feeds `hook` into the tracker.
- `POST /api/sessions/:id/status` with `{status: "busy" | "done"}` for tools that want
  finer control.
- `GET /api/sessions` returns the state list, for scripts.
- Default bind is 127.0.0.1, no auth. `--token` (or `TRING_TOKEN`) enables bearer auth on
  both HTTP and the WebSocket `hello`, for the case where the daemon is bound to a LAN
  address.

### 4.6 Claude Code integration

Optional. A `Stop` hook in `~/.claude/settings.json` running

```
curl -s -X POST "$TRING_URL/api/sessions/$TRING_SESSION_ID/done"
```

turns the tile green the moment Claude ends its turn. The env vars are inherited from the
PTY, so the same hook config is correct in every session. Without the hook the tile still
goes green after `idleMs` of silence. The README documents the snippet.

## 5. Web

### 5.1 Layout

Full-viewport 5×5 CSS grid. The centre cell spans rows and columns 2–4 and holds the
focus terminal. The 16 outer cells are slots 1–16 numbered clockwise from top-left. Each
slot shows: key legend, name or title, cwd basename, status border, and the canvas.

Status colours: grey `idle`, amber pulsing `busy`, green `done`, red `exited`. An empty
slot is a dim "+ new session" placeholder that opens the new-session dialog.

### 5.2 Thumbnails

One `<canvas>` per slot. On each `snapshot` message the canvas is repainted with a
monospace font at whatever size makes `cols × charWidth` fit the tile width, honouring
`devicePixelRatio`. Nothing is drawn between snapshots, so 16 busy sessions cost at most
64 small repaints per second.

### 5.3 Focus terminal

One xterm.js instance with the fit and webgl addons. On focus change: reset, write the
`screen` replay, attach to the live `output` stream, run fit, send `resize`. A custom key
event handler swallows the prefix key and picker keys so they never reach the PTY. Clicking
a thumbnail focuses its session directly, without the picker.

### 5.4 Picker

Ctrl+Space toggles an overlay listing the 16 slots with status, name, and key legend.
Sessions that are `done` or `idle` are highlighted; `busy` ones are dimmed but still
selectable. Keys inside the picker:

| Key | Action |
|---|---|
| `1`–`9`, `0` | focus slot 1–10 |
| `Ctrl+1`–`Ctrl+6`, `Shift+1`–`Shift+6` | focus slot 11–16 |
| `n` | focus the next `done` session clockwise from the current one |
| `Space` or `Ctrl+Space` | focus the previously focused session |
| `c` | new session dialog |
| `r` | rename focused session |
| `x` | kill focused session, with confirmation |
| `m` | mark focused session seen (`done` → `idle`) |
| `Esc` | close |

The picker header and the document title show the count of `done` sessions, e.g.
`(3) tring`, so the count is visible from other browser tabs.

## 6. Testing

- `shared`: vitest for ActivityTracker — keystroke echo stays `idle`; sustained output goes
  `busy` then `done` after `idleMs`; OSC 133;D, BEL, and hook go `done` immediately; focus
  alone keeps `done`; focus plus input clears it; exit from any state. Keymap tests.
- `server`: vitest for `snapshot.ts` (known ANSI in, expected runs out) and one
  integration test that spawns a real session running `printf` and `sleep`, connects over
  the WebSocket protocol, and asserts the status transitions and the replay on focus.
- `web`: strict TypeScript build. Behaviour is verified manually per §8.

## 7. Known constraints

- Chrome and Firefox reserve Ctrl+1 through Ctrl+8 for tab switching and pages cannot
  intercept them. Ctrl+digit for slots 11–16 works only where the browser lets it through,
  for example in an installed PWA window. Shift+digit is the guaranteed fallback and is
  matched on `event.code` (Digit1–6) so it is keyboard-layout independent. Both are printed
  on the tiles. The keymap is one object in `shared/keymap.ts`.
- Chrome allows roughly 16 WebGL contexts per page. Only the focus terminal uses WebGL;
  thumbnails are plain 2D canvases.
- Daemon restart loses scrollback. Sessions are respawned in their cwds so the ring looks
  the same, but the history is gone.
- Ctrl+Space may be claimed by an input method or window manager. The prefix key is
  configurable in the same keymap object.

## 8. Verification

1. `npm test` passes in `shared` and `server`.
2. `npm run dev`, open `http://127.0.0.1:7331`, create three sessions in different cwds.
3. In one, run `sleep 5 && echo hi`. The tile is amber during the sleep and green about
   3 s after the echo. Ctrl+Space then `n` jumps to it. Typing clears the green.
4. Run Claude Code in another session and ask it something. The thumbnail animates while it
   works and turns green when it stops, both with and without the Stop hook installed.
5. Reload the page. Sessions, scrollback, and statuses are intact. Switching sessions
   replays the full screen and keystrokes reach the right PTY.
6. Fill all 16 slots and confirm the page stays responsive.
