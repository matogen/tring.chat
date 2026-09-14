# tring.chat — browser agents implementation plan

Spec: [`../specs/2026-09-03-tring-design.md`](../specs/2026-09-03-tring-design.md) §4.7,
§4.8, §5.13, and the amendments to §4.1, §4.3, §4.4, §4.5, §5.2, §5.3, §5.5, §5.7, §5.9.

Build order. The attachment model lands in the data layer first and the choice appears in
the UI last, so every stage below ships a daemon that still serves terminals to a client
that has never heard of a browser.

## Constraints (from the spec)

- `SessionInfo.browser` is `BrowserInfo | null`. **No `kind` enum** anywhere (§4.7).
- Attach and detach never touch the PTY. A user who toggles the control keeps their shell,
  their process and their scrollback (§9.13).
- Nothing in §4.7 or §4.8 loads unless the feature is enabled: lazy `import()`, and
  `playwright-core` as an `optionalDependency`. `npm i -g tring-chat` does not grow (§6).
- Frames are gated exactly like snapshots — active project only (§4.4).
- The daemon's own origin is refused regardless of allowlist (§4.7).
- The human's keystrokes are never fed back to the agent (§8).
- Existing clients parse the wire unchanged: the channel tag rides after the id separator
  in binary frames (§4.4).

## Stages

**1. shared** *(done)* — `protocol.ts`: `BrowserInfo`, `browser` on `SessionInfo`, the six new client
messages, `frame`/`browser` server messages, `capabilities` on `state`, and the channel tag
in `encodeOutput`/`decodeOutput`. `browser-policy.ts`: the allowlist matcher and the
daemon-origin refusal, pure. `browser-control.ts`: the wheel state machine, pure and
clock-injected like `ActivityTracker`. Vitest on both pure modules — this is where the
`?token=` test and the grab/release/resume tests live, and neither needs Playwright.

**2. server, headless** *(done)* — `browser.ts`: lazy Playwright resolution, filesystem
capability detection, per-project persistent context, one page per session, CDP screencast
with frame ack. `session.ts` gains `browser: AttachedBrowser | null`.
`session-manager.ts` gains attach/detach. `project-manager.ts` persists `browser` on both
project and session and reattaches on respawn. `ws.ts` routes the new messages and gates
frames. `http.ts` serves `/api/capabilities` and the install stream.

Three things the implementation changed in the spec, all amended there:
- **One context per project, one page per session** — not one context per session.
  Playwright cannot give per-session contexts *and* a persistent per-project profile, and
  persistence is the half worth having (§4.7).
- **No `TRING_BROWSER_ID`** — a shell's environment is fixed at spawn and attachment
  happens afterwards, so scoping uses `TRING_SESSION_ID`, which is already there (§4.8).
- **Capability detection reads the filesystem**, because importing `playwright-core` costs
  ~400ms at every daemon start (§6). A test pins the cost.

**3. web, view only** *(done)* — `browser-pane.ts` painting frames into a split focus cell,
the header strip, the draggable divider with a per-session ratio (`split.ts`, pure and
tested like `ring-layout.ts`), and the two-half thumbnail in `thumbnail.ts`. Navigation
buttons are wired because they are `browserNavigate` messages the daemon already answers;
mouse and key dispatch into the page is stage 4.

The terminal moved into a permanent `.term-half` wrapper so the pane is a sibling — §5.4's
"never detach the focus cell" rule extended to the split. The phone view stacks rather than
becoming tabs, and §5.13 now records why: a tab hides the other half, which is the one thing
this product exists not to do.

**Not yet visually verified** — no Chromium is installed on this machine, so frames have
never actually been rendered. The pure geometry is unit-tested and the whole thing
typechecks and builds, but the canvas sizing, flex-basis and JPEG decode paths have not run.

**4. web, input** *(done)* — normalised mouse/key/wheel forwarding, implicit grab, the
explicit give-back button, the amber border while the human holds the wheel.

- `BrowserInfo` gains the page's `viewport`, because frames are letterboxed and a click has
  to be mapped back through that scale. The viewport is deliberately not resized to match
  the pane (§5.13).
- `shared/browser-input.ts` rebuilds every event field by field before it reaches CDP, and
  is the one new security surface this stage adds (§4.7). 17 tests.
- `letterbox`/`toPagePoint` live in `split.ts` beside the divider geometry, so painting and
  input mapping cannot drift apart.

**Still not visually verified.** Stages 3 and 4 are both rendering and input code that has
never run — no Chromium is installed. The pure geometry and the sanitiser are tested, and
everything typechecks and builds, but no frame has been painted and no click has reached a
page. This is the accumulated risk to clear before stage 6 calls anything finished.

**5. tools** *(done)* — `mcp.ts`: the tool table of §4.8, blocking-not-erroring while the
human drives, and the handback note on the next result. `browser_eval` behind its own
per-project flag. Actions land on `/api/browser/:sessionId/:action`, so the wheel and the
allowlist cannot be bypassed by talking to the daemon directly.

One more spec correction, amended in §4.8: **stdio, not an HTTP MCP endpoint.** An HTTP
server sees a socket, not a process, so it cannot read the caller's `TRING_SESSION_ID` —
it would have to take a session id as a parameter, and a tool that takes a session id is a
tool one agent can point at another agent's page. `tring mcp` runs as a child of the agent
and inherits what §4.1 already injects.

`ActionGate` was extracted from `AttachedBrowser` into `shared/browser-control.ts` so the
park-and-resume wiring is testable without a page. It is the piece that hangs an agent
forever if it is wrong.

**6. surface the choice** *(done)* — the segmented control in `openNewSessionDialog` and
`openSessionDialog`, `b` in the picker, the three-state settings control with the install
progress bar, the allowlist editor, README section.

- The control reuses the ring-size `.choices` widget, because it is the same kind of
  choice and should not look like a different one.
- `SessionManager.setBrowserHost` exists because a project that is already running took
  its host at spawn time, so a switch flipped now has to reach it. Disabling detaches what
  is open: pages running under a switch that says off is a gap someone finds later.
- `projectBrowser` goes to the daemon, not `localStorage`, and broadcasts state — the
  capability is per project, so every client viewing it needs the new answer, not only the
  one that flipped the switch.

## Verification

Spec §9, steps 11–19, in order. The two that must not silently regress:

- **§9.13** — attaching to a live session leaves the PTY, its process and its scrollback
  intact, and detaching returns a full-width terminal still running. Every other claim in
  this design is downstream of that one.
- **§9.17** — the agent cannot navigate to the daemon's own origin, and cannot be allowed
  to from the prompt. The WebSocket origin check does not cover this case (§4.7), so this
  test is the only thing standing in front of it.

## Deferred

`storageState` import ("use my existing logins"), headed-context pop-out, multiple pages
per context, and browser tiles with no shell behind them. All four are additive. The last
one is the only one that would force the `Session`-as-interface refactor, which the
attachment model of §4.7 exists partly to avoid needing.
