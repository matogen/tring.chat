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

## Status

Design complete, implementation not started. The design is in
[`docs/superpowers/specs/2026-09-03-tring-design.md`](docs/superpowers/specs/2026-09-03-tring-design.md).

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
| `Space` | back to the previous session |
| `c` / `r` / `x` | new session / rename / kill |
| `m` | mark seen |
| `Esc` | close the picker |

Browsers reserve `Ctrl+1`–`Ctrl+8` for tab switching, so `Shift+digit` is the
fallback that always works. Clicking a thumbnail also focuses it.

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

`TRING_URL` and `TRING_SESSION_ID` are set in every session's environment.

## Stack

TypeScript throughout. Server: Node, `node-pty`, `@xterm/headless`, `ws`.
Web: Vite, `@xterm/xterm`, no UI framework. Tests: vitest.

## Running

Not yet. Once implemented:

```
npm install
npm run dev        # daemon on http://127.0.0.1:7331 with Vite hot reload
npm run build && npm start
```

## Licence

TBD.
