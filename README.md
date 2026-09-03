# tring.chat

A focus-centred terminal deck for agentic work.

Run many agent sessions at once — Claude Code, other coding agents, plain shells — and
stay focused on one. The session you are working in fills the centre of the screen.
Up to 16 others run in zoomed-out live thumbnails around it, so you can see them
working. When a session finishes and is waiting for you, its tile turns green.
Press `Ctrl+Space`, then one key, and that session is in the centre.

```
┌────┬────┬────┬────┬────┐
│ 1  │ 2  │ 3  │ 4  │ 5  │
├────┼────┴────┴────┼────┤
│ 16 │              │ 6  │
├────┤    focus     ├────┤
│ 15 │   terminal   │ 7  │
├────┤              ├────┤
│ 14 │              │ 8  │
├────┼────┬────┬────┼────┤
│ 13 │ 12 │ 11 │ 10 │ 9  │
└────┴────┴────┴────┴────┘
```

Slots are fixed. Focusing a session shows it in the centre without moving it, so the
ring never shuffles and slot numbers stay in muscle memory.

## Install

```
npm install
npm run build
npm i -g ./packages/server
tring
```

`tring` starts the daemon and opens a chromeless browser window — no address bar, no
tab strip, its own taskbar entry. In that window the browser stops reserving
`Ctrl+1`–`Ctrl+8` for tab switching, so slots 11–16 get their natural keys.

To run from a checkout instead:

```
npm run build && npm start          # daemon on http://127.0.0.1:7331
npm run dev                         # tsx watch, no window (TRING_NO_OPEN)
npm test                            # vitest
```

Flags: `--port` (7331), `--host` (127.0.0.1), `--token`, `--scrollback` (5000),
`--idle-ms` (3000), `--no-open`.

## Projects

A project is a name and a root directory, and it owns its own 16 slots and its own
picker. The first run asks you to create one. Add more with `+` in the tab bar, and
switch with a click or `p` inside the picker.

So you can keep one project with 16 terminals, or one project per repository — each
with its own ring.

Sessions in projects you are **not** looking at keep running and keep being tracked.
Their tab shows a green badge counting how many have finished, so a background agent
finishing is visible without rendering its ring. Only the project you are viewing
streams thumbnails, which is what keeps several projects cheap.

## How it works

- A local Node daemon owns every terminal (PTY) and keeps a headless copy of its
  screen and scrollback. Reloading the browser loses nothing.
- The browser runs one real terminal (xterm.js) for the centre. Thumbnails are small
  canvases repainted from throttled screen snapshots, so 16 busy sessions stay cheap.
- A session is **busy** while it produces output, **done** (green) when it goes quiet,
  when the shell prompt returns (OSC 133), when it rings the bell, or when a Claude Code
  Stop hook calls back. It stays green until you type into it, so you can read the
  result first.

## Keys

| Key | Action |
|---|---|
| `Ctrl+Space` | open the picker |
| `1`–`9`, `0` | focus slot 1–10 |
| `Ctrl+1`–`Ctrl+6` or `Shift+1`–`Shift+6` | focus slot 11–16 |
| `n` | focus the next finished session |
| `p` | switch project |
| `Space` | back to the previous session |
| `c` / `r` / `x` | new session / rename / kill |
| `m` | mark seen |
| `Esc` | close the picker |

Browsers reserve `Ctrl+1`–`Ctrl+8` for tab switching, so `Shift+digit` is the
fallback that always works in an ordinary tab. Clicking a thumbnail also focuses it.

## Restarting

Reopening brings back every project with its tabs, slots, names and working
directories. The active project's shells spawn immediately; other projects spawn when
you first switch to them.

Two things are deliberate:

- **Scrollback is not restored.** The buffer lives in daemon memory, and persisting
  dozens of sessions of history to disk continuously is a different product.
- **A recorded command is offered, never re-run.** A restored slot gets a plain shell
  in the right directory, with its old command on the tile as a one-click re-run.
  Auto-executing whatever was there last time is how four dev servers end up fighting
  over a port.

## Claude Code

Optional. Add a `Stop` hook to `~/.claude/settings.json` so a tile turns green the
instant Claude ends its turn instead of after the idle timeout:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "curl -s -X POST \"$TRING_URL/api/sessions/$TRING_SESSION_ID/done\"" } ] }
    ]
  }
}
```

`TRING_URL`, `TRING_SESSION_ID`, `TRING_SLOT` and `TRING_PROJECT` are set in every
session's environment. Session ids are globally unique, so this one snippet is correct
in every session of every project and does not change as projects come and go.

## Stack

TypeScript throughout. Server: Node, `node-pty`, `@xterm/headless`, `ws`.
Web: Vite, `@xterm/xterm`, no UI framework. Tests: vitest.

Design: [`docs/superpowers/specs/2026-09-03-tring-design.md`](docs/superpowers/specs/2026-09-03-tring-design.md).

## Licence

TBD.
