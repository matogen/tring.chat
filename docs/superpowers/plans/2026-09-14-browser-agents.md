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

**1. shared** — `protocol.ts`: `BrowserInfo`, `browser` on `SessionInfo`, the six new client
messages, `frame`/`browser` server messages, `capabilities` on `state`, and the channel tag
in `encodeOutput`/`decodeOutput`. `browser-policy.ts`: the allowlist matcher and the
daemon-origin refusal, pure. `browser-control.ts`: the wheel state machine, pure and
clock-injected like `ActivityTracker`. Vitest on both pure modules — this is where the
`?token=` test and the grab/release/resume tests live, and neither needs Playwright.

**2. server, headless** — `browser.ts`: lazy Playwright resolution, capability detection,
shared process, per-session context, per-project profile dir, CDP screencast with frame
ack. `session.ts` gains `browser: BrowserSession | null` and `TRING_BROWSER_ID`.
`session-manager.ts` gains attach/detach. `project-manager.ts` persists `browser` on both
project and session and reattaches on respawn. `ws.ts` routes the new messages and gates
frames. `http.ts` serves `/api/capabilities` and the install stream. Verifiable with curl
and no UI: attach to a session, confirm frames arrive on the socket, confirm the PTY is
untouched.

**3. web, view only** — `browser-pane.ts` painting frames into a split focus cell, the
header strip, the draggable divider with a per-session ratio, and the two-half thumbnail in
`thumbnail.ts`. Read-only: no input forwarding yet. At the end of this stage you can watch a
browser you cannot touch, which is already most of the value and isolates the rendering
work from the input work.

**4. web, input** — normalised mouse/key/wheel forwarding, implicit grab, the explicit
give-back button, the amber border while the human holds the wheel. The §9.15 login
walkthrough becomes runnable here.

**5. tools** — `browser-tools.ts`: the MCP endpoint, `TRING_BROWSER_ID` scoping, the tool
table of §4.8, blocking-not-erroring while the human drives, and the accessibility-snapshot
resync on release. `browser_eval` behind its own per-project flag.

**6. surface the choice** — the segmented control in `openNewSessionDialog` and
`openSessionDialog`, `b` in the picker, the three-state settings control with the install
progress bar, the allowlist editor, README section. Last on purpose: until stage 5 lands
there is nothing behind the control worth offering, and shipping it earlier means shipping
a control that half-works.

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
