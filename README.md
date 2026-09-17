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

Sixteen is the default, not the only option — the gear in the tab bar switches to 12, 8
or 4. See [Ring size](#ring-size).

## Install

```
npm i -g tring-chat
tring
```

Node 20 or newer. node-pty ships prebuilt binaries for macOS and Windows —
`darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64` — so those install with no
compiler step.

**Linux and WSL build node-pty from source.** There is no Linux prebuild, so the
install runs `node-gyp` and needs a toolchain:

```
sudo apt install -y build-essential python3      # Debian/Ubuntu/WSL
sudo dnf install -y gcc-c++ make python3         # Fedora/RHEL
```

Without those, `npm i -g tring-chat` fails while building node-pty. It takes a few seconds
once they are present.

**macOS needs no compiler, but node-pty's prebuilds carry one defect.** It
publishes `prebuilds/darwin-*/spawn-helper` without the execute bit
([node-pty#850](https://github.com/microsoft/node-pty/issues/850)), and every
PTY on macOS is forked through that binary — so an untreated install answers
the first tile with `posix_spawnp failed` and starts no shell. tring puts the
bit back, at install time and again before the first spawn, so this should
never be visible. If you installed with `--ignore-scripts` into a prefix you
do not own, the one-liner is:

```
sudo chmod +x "$(npm root -g)/tring-chat/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
```

All of this goes away when node-pty publishes a stable release carrying the fix.

`tring` starts the daemon and opens a chromeless browser window — no address bar, no
tab strip, its own taskbar entry. In that window the browser stops reserving
`Ctrl+1`–`Ctrl+8` for tab switching, so slots 11–16 get their natural keys.

### Windows

node-pty ships prebuilt binaries for `win32-x64` and `win32-arm64`, so no Visual
Studio Build Tools, Python or node-gyp are needed. From PowerShell:

```powershell
npm i -g tring-chat
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

Flags: `--port` (7331), `--host` (127.0.0.1), `--token`, `--tls-cert`, `--tls-key`,
`--scrollback` (5000), `--idle-ms` (3000), `--shell`, `--fs-root`, `--allow-origin`,
`--insecure-no-token`, `--no-open`, `--no-update-check`, `--version`.

## On a phone

Below 720px wide tring stops drawing the ring. The focus terminal fills the screen, and a
bar under the project tabs shows which session you are in. Tap it to get the same picker
`Ctrl+Space` opens on desktop, as a sheet you can thumb through; the button beside it jumps
to the next finished session and counts how many are waiting.

The daemon only listens on `127.0.0.1` by default. Reaching it from a phone means binding
it to the network, and that traffic has to be encrypted — it carries the token, every
keystroke you type into a shell and everything the shell prints back, which is exactly
where SSH passphrases, API keys and `.env` contents live.

**Use an encrypted overlay network.** Tailscale or WireGuard, with the daemon still on the
address that network gives you. This is the supported way, not the cautious one:

```
tring --host 100.x.y.z          # the Tailscale address of this machine
```

If you must serve the LAN directly, terminate TLS yourself:

```
tring --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem
```

Then open the link the daemon prints on the phone. `--tls-cert`/`--tls-key` switch the
daemon to `https` and `wss`; the page follows automatically. Bound off localhost over
plain `http`, the daemon warns at startup, because anyone on that network segment can read
the token off the wire and then has a shell.

Binding off localhost with `--insecure-no-token` is refused at startup rather than warned
about: the daemon spawns shells, and off loopback the token is the only thing in front of
them.

The token is remembered on that first visit and then taken back off the address bar, but
a secret that has travelled in a URL is only as private as the URL: it has already been
through your history, any proxy log on the way, and whatever chat app you sent the link
in. Treat the link as the secret, and rotate it by deleting `~/.config/tring/token` (or
passing a new `--token`) rather than assuming an old link has expired.

## Who can reach the daemon

The daemon spawns shells, so **it requires a bearer token by default, on loopback as much
as off it.** Binding to `127.0.0.1` is not an authentication boundary: every process on
the machine can reach it — a postinstall script in some dependency of some project, a
second user account, a container sharing the host network namespace — and "can run code
on this box as any user" is not a boundary worth having in front of a shell.

If you do not pass `--token`, one is generated on first run and kept at
`~/.config/tring/token` with mode `0600`. It is stable across restarts, and the daemon
hands it to the browser window it opens, so there is nothing to copy by hand.

- **Scripts on the same machine** read the token back out of that file, which is what
  keeps curl and `/api/sessions` working while other users on the box stay out:

  ```
  curl -s -H "Authorization: Bearer $(cat ~/.config/tring/token)" \
    http://127.0.0.1:7331/api/sessions
  ```

  Inside a tring session there is nothing to read: `$TRING_TOKEN` is already set.
- **Another browser** needs the link once — `http://127.0.0.1:7331/?token=<secret>`. The
  page stores it and scrubs it from the address bar, so installed PWAs start without it.
- `--insecure-no-token` turns authentication off entirely, and says so at startup. It is
  the only way to get the old unauthenticated behaviour back.

On top of the token, the daemon only answers requests from the page it serves itself. The
same-origin policy does not cover WebSockets, so without that check any website you
happened to have open could open a socket to `ws://127.0.0.1:7331` and type into your
terminals.

- A browser page from another origin is refused at the handshake. So is a domain rebound
  to 127.0.0.1, while the daemon is on loopback.
- Non-browser clients send no `Origin` and are unaffected by *that* check — they need the
  token instead.
- `--allow-origin <origin>` adds one, for a front end you serve yourself. `npm run dev`
  sets it for the Vite server on :5173.
- The token is compared in constant time. Off loopback the origin check cannot cover for
  it: the hostname is then your own and unguessable to the daemon, so `Host` goes unpinned
  and a rebound name matches it.
- The directory picker (`/api/fs`) browses your home directory and the roots of projects
  you have already created. `--fs-root <path>` adds another — useful if your projects
  live somewhere like `D:\work`. Paths are resolved through symlinks before the check, so
  a link inside a root is not a way back out of it.

What this does **not** protect against: the browser window the daemon opens is launched
with the token on its command line, so on a shared machine another user who can read
`/proc/<pid>/cmdline` can read it there. The same is true of `--token` on your own command
line. If that matters, start with `--no-open` and open the printed link by hand.

## Install it as an app

tring is a progressive web app. Once it is open in a browser, install it and it gets its
own icon and window with no address bar:

- **Android (Chrome):** the browser menu, then *Install app* or *Add to Home screen*.
- **iPhone and iPad (Safari):** the share button, then *Add to Home Screen*.
- **Desktop (Chrome, Edge):** the install icon at the right of the address bar.

Open it once with `?token=<secret>` on the URL before installing — the window the daemon
opens for you already carries it, and `~/.config/tring/token` holds it otherwise. The
token is remembered in the browser, so the installed app starts without it. Opening a link
with a new token replaces the remembered one.

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
  result first. A busy tile is dimmed and grey as well as amber-bordered, and a green
  one shows its slot number in a circle, so what is waiting and which key to press are
  both visible at a glance.

## Keys

| Key | Action |
|---|---|
| `Ctrl+Space` | open the picker |
| `1`–`9`, `0` | focus slot 1–10 |
| `Ctrl+1`–`Ctrl+6` or `Shift+1`–`Shift+6` | focus slot 11–16 |
| `n` | focus the next finished session |
| `p` | switch project |
| `Space` | back to the previous session |
| `c` / `r` / `x` | new session / rename and colour / kill |
| `m` | mark seen |
| `Esc` | close the picker |

Browsers reserve `Ctrl+1`–`Ctrl+8` for tab switching, so `Shift+digit` is the
fallback that always works in an ordinary tab. Clicking a thumbnail also focuses it,
and right-clicking one opens the same dialog `r` does.

## Naming and colouring tiles

Right-click a tile — or press `r` in the picker — to give it a name and a colour.

The colour is a ring *outside* the status border, never instead of it, so a tile you
have tinted still reports whether it is busy, finished or dead. Twenty-four choices:
twelve hues — red, orange, gold, lime, green, teal, cyan, blue, indigo, violet, pink,
slate — in a bright and a deep tier.

Red, gold and green are in there, which means a tint can echo a status colour that means
something else. That stays readable because they are separate rings, but it is worth
knowing when you pick: mint means *finished*, amber means *busy* and red means *dead*,
and those meanings belong to the border, not to your tint.

Names and colours are per session and survive a restart, alongside the slot and the
working directory.

## Updating

A global npm install is a frozen snapshot: npm never checks for new versions
and never notifies. So tring asks the registry itself, at most once a day, and
shows a notice in the tab bar when a newer release exists.

```
npm i -g tring-chat
```

Running sessions are unaffected until you restart the daemon. The check never
blocks startup and fails silently when offline. Opt out with
`--no-update-check` or `TRING_NO_UPDATE_CHECK=1`.

## Ring size

Sixteen terminals is the default. The gear in the tab bar offers 4, 8, 12 and 16, and the
choice is remembered per browser.

Twelve and sixteen are rings. Four and eight are bands — a row above and a row below, with
the focus terminal spanning the full width, because below twelve slots a ring's side
columns cost the centre more width than the tiles are worth:

```
     4 slots                    8 slots
┌────────┬────────┐      ┌────┬────┬────┬────┐
│   1    │   2    │      │ 1  │ 2  │ 3  │ 4  │
├────────┴────────┤      ├────┴────┴────┴────┤
│      focus      │      │       focus       │
├────────┬────────┤      ├────┬────┬────┬────┤
│   4    │   3    │      │ 8  │ 7  │ 6  │ 5  │
└────────┴────────┘      └────┴────┴────┴────┘
```

The daemon is unaffected: every project still owns sixteen slots, so this is a view onto
them rather than a limit on them. Shrinking below a slot that is in use is refused with a
notice rather than hiding a session that would still ring and still count in the tab badge
— close those sessions first, or switch back up.

## Claude usage

Optional, off by default. Turn on **Enable Claude usage monitoring** in the gear, and a
pinned `Usage` tab appears in the tab bar — a quick glance at what Claude Code has spent,
without leaving tring.

```
Session             ████░░░░░░░░  27%    resets Sep 4, 11:29am
Week (all models)   ████░░░░░░░░  27%    resets Sep 7, 9:59am
Week (Fable)        ████░░░░░░░░  28%    resets Sep 7, 9:59am
                                  from Claude Code’s own /usage

  1.7M tokens today  ·  $34.55 today  ·  $622.47 this week  ·  750B cache reads
```

**The percentages are the real ones.** Opening the tab runs `claude -p "/usage"`, which
Claude Code answers locally — zero turns, zero tokens, no API call — so the numbers are
exactly what `/usage` shows in a session. Nothing is read out of your credential file and
nothing leaves the machine. The answer is cached for 30 seconds, so the first look costs
about 1.8s and the rest are instant.

Underneath, the token counts and cost estimates come from Claude Code's transcripts in
`~/.claude/projects` (or `CLAUDE_CONFIG_DIR`), which is also where the per-project split
comes from — `/usage` does not break usage down by repository. A full scan of a year of
history takes about half a second.

The token count is `input + output + cache creation`. Cache reads are shown separately
rather than folded in: a typical week here is 750B cache reads against 22M other tokens,
so including them would make the bar 99% cache and tell you nothing. Costs are estimates
from a built-in price table.

If the `claude` command is not on the daemon's PATH — running tring natively on Windows
against a WSL install, say — the tab reports the transcript numbers on their own and says
why there is no percentage. There is nothing to configure either way: a bar needs a real
ceiling, and inventing one would be worse than having none.

Reloading while the tab is open leaves you on it.

## Sound

When a session turns green, tring rings — two short strikes, synthesised rather
than shipped as an audio file. Toggle it with the bell in the tab bar; the
choice is remembered per browser.

It rings only on the transition to green, so reconnecting or reloading a page
full of finished sessions stays silent.

It also rings only when the daemon is *confident* something finished. An
explicit signal — a Claude Code Stop hook, an OSC 133 prompt marker, a terminal
bell — always rings, because each means exactly one thing. Silence after output
is a guess, and an app that has merely finished starting up looks identical to
one that has finished working: Claude Code draws its interface for a few
seconds and then waits. So an inferred finish only rings after ten seconds of
sustained work, while the tile still turns green either way.

Installing the Stop hook below is what makes this exact for Claude Code.

## Restarting

Switching projects puts you back in the session you were last using in that project,
rather than an empty centre.

Reopening brings back every project with its tabs, slots, names and working
directories. The active project's shells spawn immediately; other projects spawn when
you first switch to them.

If your shell's startup file changes directory — `cd /mnt/c` in a `~/.bashrc`,
say — it runs *after* the shell has been placed in the directory you chose, and
would otherwise silently discard that choice. tring puts the shell back once,
shortly after start, unless you have already typed something: at that point the
shell is yours.

Sessions come back in the directory the shell was actually in, not the one it
was started in — `cd` somewhere and that is where you return. The daemon reads
this from the shell's own process on Linux and WSL, and from OSC 7 on shells
that emit it.

Two things are deliberate:

- **Scrollback is not restored.** The buffer lives in daemon memory, and persisting
  dozens of sessions of history to disk continuously is a different product.
- **A recorded command is offered, never re-run.** A restored slot gets a plain shell
  in the right directory, with its old command on the tile as a one-click re-run.
  Auto-executing whatever was there last time is how four dev servers end up fighting
  over a port.

## Dropping images on a terminal

Drag a screenshot onto the centre terminal and its path is typed into the prompt,
the way dropping a file on any other terminal types one. Claude Code reads the
path from there.

It cannot work the way a native terminal's does. A browser hands a dropped file
over as bytes and withholds its location by design, and that location would be
the wrong machine's anyway whenever you have the deck open on a phone or a laptop
across the room. So the bytes go to the daemon, which writes them down on the
machine the shell is actually running on and answers with the path it chose.

- PNG, JPEG, GIF and WebP, up to 10MB. The type is read from the file's first
  bytes, not from what the browser called it.
- The daemon names every file itself, under `~/.config/tring/uploads`. Nothing
  a client sends reaches a filesystem path.
- The last 20 are kept. The directory is emptied when the daemon stops.
- The upload goes through the same token as the rest of the API.

## Claude Code

Optional. Add a `Stop` hook to `~/.claude/settings.json` so a tile turns green the
instant Claude ends its turn instead of after the idle timeout:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "curl -s -X POST -H \"Authorization: Bearer $TRING_TOKEN\" \"$TRING_URL/api/sessions/$TRING_SESSION_ID/done\"" } ] }
    ]
  }
}
```

In a PowerShell session the same hook is:

```powershell
curl.exe -s -X POST -H "Authorization: Bearer $env:TRING_TOKEN" "$env:TRING_URL/api/sessions/$env:TRING_SESSION_ID/done"
```

`curl.exe` rather than `curl`, which PowerShell aliases to `Invoke-WebRequest`.

`TRING_URL`, `TRING_TOKEN`, `TRING_SESSION_ID`, `TRING_SLOT` and `TRING_PROJECT` are set
in every session's environment. Session ids are globally unique, so this one snippet is
correct in every session of every project and does not change as projects come and go.

The `Authorization` header is what changed when the daemon started requiring a token by
default. A hook written against an older tring still runs, but the request now comes back
`401` and the tile waits for the idle timeout instead of turning green immediately.

## Stack

TypeScript throughout. Server: Node, `node-pty`, `@xterm/headless`, `ws`.
Web: Vite, `@xterm/xterm`, no UI framework. Tests: vitest.

Design: [`docs/superpowers/specs/2026-09-03-tring-design.md`](docs/superpowers/specs/2026-09-03-tring-design.md).

## Licence

MIT.
