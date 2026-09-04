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
npm i -g tring
tring
```

Node 20 or newer. node-pty ships prebuilt binaries for linux-x64, darwin-x64,
darwin-arm64, win32-x64 and win32-arm64, so there is no compiler step on any of
them.

`tring` starts the daemon and opens a chromeless browser window — no address bar, no
tab strip, its own taskbar entry. In that window the browser stops reserving
`Ctrl+1`–`Ctrl+8` for tab switching, so slots 11–16 get their natural keys.

### Windows

node-pty ships prebuilt binaries for `win32-x64` and `win32-arm64`, so no Visual
Studio Build Tools, Python or node-gyp are needed. From PowerShell:

```powershell
npm i -g tring
tring
```

That is all that is needed to *use* it. The rest of this section applies only
if you are working on tring itself from a checkout.

**Use a separate clone for Windows.** `node_modules` holds a compiled
`node-pty` binary for one platform only, so running `npm install` on Windows in
a folder you also use from WSL replaces the Linux binary and breaks the WSL
side, and vice versa. Two checkouts, or `rm -rf node_modules && npm install`
each time you switch.

Sessions default to `powershell.exe`. To choose otherwise:

```powershell
tring --shell pwsh.exe     # PowerShell 7
tring --shell cmd.exe
tring --shell wsl.exe      # WSL shells from the Windows app
```

`--shell wsl.exe` is worth knowing about: it runs the daemon natively on
Windows while every terminal is a WSL bash shell, which is usually where the
dev tooling and Claude Code actually live.

Config lives at `%USERPROFILE%\.config\tring\projects.json`.

To run from a checkout instead:

```
npm install
npm run build && npm start          # daemon on http://127.0.0.1:7331
npm run dev                         # tsx watch, no window (TRING_NO_OPEN)
npm test                            # vitest
npm i -g ./packages/server          # install this checkout as `tring`
```

Flags: `--port` (7331), `--host` (127.0.0.1), `--token`, `--scrollback` (5000),
`--idle-ms` (3000), `--shell`, `--no-open`, `--no-update-check`, `--version`.

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

## Updating

A global npm install is a frozen snapshot: npm never checks for new versions
and never notifies. So tring asks the registry itself, at most once a day, and
shows a notice in the tab bar when a newer release exists.

```
npm i -g tring
```

Running sessions are unaffected until you restart the daemon. The check never
blocks startup and fails silently when offline. Opt out with
`--no-update-check` or `TRING_NO_UPDATE_CHECK=1`.

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

In a PowerShell session the same hook is:

```powershell
curl.exe -s -X POST "$env:TRING_URL/api/sessions/$env:TRING_SESSION_ID/done"
```

`curl.exe` rather than `curl`, which PowerShell aliases to `Invoke-WebRequest`.

`TRING_URL`, `TRING_SESSION_ID`, `TRING_SLOT` and `TRING_PROJECT` are set in every
session's environment. Session ids are globally unique, so this one snippet is correct
in every session of every project and does not change as projects come and go.

## Stack

TypeScript throughout. Server: Node, `node-pty`, `@xterm/headless`, `ws`.
Web: Vite, `@xterm/xterm`, no UI framework. Tests: vitest.

Design: [`docs/superpowers/specs/2026-09-03-tring-design.md`](docs/superpowers/specs/2026-09-03-tring-design.md).

## Licence

MIT.
