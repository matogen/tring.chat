# tring.chat — implementation plan

Spec: [`../specs/2026-09-03-tring-design.md`](../specs/2026-09-03-tring-design.md)

Build order. Projects exist in the data model from the first commit; the ring is built
inside an auto-created default project, so the project UI lands last with no rework.

## Constraints (from the spec)

- TypeScript strict, end to end. No UI framework.
- Port 7331, bind 127.0.0.1. `--scrollback` default 5000, `idleMs` default 3000.
- 16 slots per project. Session ids globally unique — the HTTP API and the Claude Code
  Stop hook must never need a project segment.
- `--mint` `#3ee9a4` only ever means `done`. Chrome uses `--deep`/`--emerald`.
- xterm ANSI 0–15 stay at defaults. Fonts vendored, no CDN.

## Stages

**1. shared** — `status.ts` (ActivityTracker, pure, clock injected), `keymap.ts`,
`protocol.ts`. Vitest on the first two; `tsc --noEmit` covers the types.

**2. server** — `snapshot.ts`, `session.ts` (PTY + headless xterm + OSC/BEL parsing),
`session-manager.ts` (16 slots), `project-manager.ts` (projects.json, eager active /
lazy background respawn, never auto-runs a recorded command), `ws.ts`, `http.ts`,
`index.ts`. Vitest on snapshot and project-manager; one real-PTY integration test over
the WebSocket.

**3. web** — `theme.css`, `xterm-theme.ts`, `ring-layout.ts`, `focus-terminal.ts`,
`thumbnail.ts`, `picker.ts`, `new-session-dialog.ts`. Runs against the default project.

**4. projects UI + distribution** — `project-bar.ts`, `project-dialog.ts`, `p` in the
picker, `open-window.ts` (chromeless `--app` window), README refresh.

## Verification

Spec §9, in order. The one test that must not silently regress: snapshots are not emitted
for sessions outside the socket's active project, while their statuses still are.

## Deferred

Electron packaging (spec §6), git worktree awareness, marketing-page rewrite. All three
are additive and none block the stages above.
