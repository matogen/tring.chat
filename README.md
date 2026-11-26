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
`Ctrl+1`–`Ctrl+8` for tab switching, so slots 11–20 get their natural keys.

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
`--insecure-no-token`, `--no-open`, `--no-update-check`, `--allow-sleep`, `--version`.

## On a phone

Below 720px wide tring stops drawing the ring. The focus terminal fills the screen, and a
bar under the project tabs shows which session you are in. Tap it to get the same picker
`Ctrl+Space` opens on desktop, as a sheet you can thumb through; the button beside it jumps
to the next finished session and counts how many are waiting. Two more buttons do what a
phone cannot do to a terminal by itself: paste from the clipboard, and copy from the screen —
the links on it with a tap each, or the screen as text to select from.

**A phone and a PC on the same session keep their own sizes.** A terminal has one size, so
it follows the device you are using: open, tap or type on the phone and it is laid out for
the phone; click, type or come back to the window on the PC and it is laid out for the PC
again, redrawn cleanly. While the other device has it, a terminal is drawn at that
device's size — narrower, or clipped — never garbled, with a note to click to fit it back.

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

A project is a name and a root directory, and it owns its own 24 slots and its own
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
| `Ctrl+1`–`Ctrl+0` or `Shift+1`–`Shift+0` | focus slot 11–20 |
| `Alt+1`–`Alt+4` | focus slot 21–24 (on a Mac Option+digit types characters: use the switcher) |
| `n` | focus the next finished session |
| `p` | switch project |
| `Space` | back to the previous session |
| `c` / `r` / `x` | new session / rename and colour / kill |
| `m` | mark seen |
| `o` | orchestrator: every agent's questions in the centre |
| `Esc` | close the picker |

Browsers reserve `Ctrl+1`–`Ctrl+8` for tab switching, so `Shift+digit` is the
fallback that always works in an ordinary tab. Clicking a thumbnail also focuses it,
and right-clicking one opens the same dialog `r` does.

Those are picker keys. Everything else you type goes to the focused session, with one
exception: **`Ctrl+Enter` and `Shift+Enter` insert a newline** instead of submitting.
A terminal has no modifier bits for Enter — every variant is a bare `\r` on the wire —
so tring sends `ESC`+`CR` for those two chords, which is what Claude Code and other
agent CLIs read as "break the line". Native terminals need `/terminal-setup` to do the
same thing; here it works out of the box.

## Rearranging tiles

Drag a tile onto another slot to move it there. Dropped on an empty slot it simply
moves; dropped on another session the two swap. The slot is the key, so a moved session
answers to its new number from then on. Escape abandons a drag. The order is saved with
the project and survives a restart.

`$TRING_SLOT` is fixed when a session's shell starts, so a moved session keeps reporting
its old slot until it is restarted. Nothing in tring relies on it: hooks and the API
address sessions by `$TRING_SESSION_ID`.

## Naming and colouring tiles

Right-click a tile — or press `r` in the picker — to give it a name and a colour.
The same dialog has a **Delete** button, which kills the session and frees the slot
back to empty; `x` in the picker does the same thing.

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

## Staying awake for phones

A phone reaches tring through this machine, so when the machine sleeps the phone
gets nothing until someone wakes it at the keyboard. Windows' idle sleep counts
only local input: a PC left locked while you work from your phone sleeps after
45 minutes on mains, however busy the phone keeps it.

So while phones can reach tring (an `--allow-origin`, or bound off localhost) the
daemon holds a request that blocks idle sleep only, the way a video player does;
the lid, the power button and Start → Sleep still sleep the machine. On Windows
it shows in `powercfg /requests` (as admin) as a `powershell.exe` under SYSTEM.
Opt out with `--allow-sleep` or `TRING_ALLOW_SLEEP=1`.

## Ring size

Sixteen terminals is the default. The gear in the tab bar offers 4, 8, 12, 16 and 24, and the
choice is remembered per browser.

Twelve, sixteen and twenty-four are rings. Four and eight are bands — a row above and a row below, with
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

The daemon is unaffected: every project owns twenty-four slots, so this is a view onto
them rather than a limit on them. Shrinking below a slot that is in use is refused with a
notice rather than hiding a session that would still ring and still count in the tab badge
— close those sessions first, or switch back up. The same goes the other way: a project
with a session above slot 16 shows the ring of 24 until that slot is free again.

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

## Phone notifications

Off by default, and per device. In the gear's settings, **Notifications on this device**
→ **Turn on**, and that browser gets a notification when the orchestrator has a card
for you — a permission prompt, a question, or an agent that finished — even with tring
closed or the phone locked. Turning it on in one browser never makes your others buzz.

- **Which cards:** each kind has its own switch.
- **Only when you are away** (on by default): no notification while any screen has tring
  in front of you — visible, and touched in the last two minutes.
- **Quiet by design:** a card is only sent if it is still waiting 15 seconds later, so the
  ones the AI approves, or that you answer straight away, never buzz. One notification
  per tile, a newer card replacing it, and at most one per tile per minute.
- **No content:** a notification says which tile and what kind of card ("tring.chat/3
  api needs permission · It wants to run a command"), never the command, code or ticket
  text. It is end-to-end encrypted to the device; the push service only relays it.
- **Send a test**, and **Turn off**, which also removes the device on the daemon.

It needs tring opened over **HTTPS** (or on `localhost`): browsers only offer push to a
secure page. A plain `http://` Tailscale address does not qualify; a real certificate
in front of tring — `tailscale serve`, a reverse proxy, a tunnel — does.

On an **iPhone or iPad** (iOS 16.4 or later), Safari only offers push to a site on the
Home Screen: open tring in Safari, Share → **Add to Home Screen**, open it from that
icon, and turn notifications on there. Android and desktop browsers work from a tab.

The daemon talks to the push service directly (Apple's, Google's or Mozilla's, whichever
the browser uses), with its own key in `~/.config/tring/push.json`.

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

### Claude conversations come back too

A tile that was running Claude Code reopens the same conversation after a restart
of tring or of the machine: tring types `claude --resume <id>` into the tile's shell
once it has started. Claude waits for your next prompt, so nothing runs that was not
already running. Quitting Claude still leaves you in that shell.

tring learns which conversation each tile is running from Claude Code's
`SessionStart` and `SessionEnd` hooks, which `tring hooks install` adds (run it again
if you installed the hooks before this, then restart your `claude` sessions once).
Ending a conversation yourself (`/exit`, Ctrl+D, `/clear`) forgets it. Stopping tring
or shutting down does not, since that is the conversation you want back. A tile that
was resumed runs plain `claude --resume`, so flags you started it with (`--model`,
a permission mode) fall back to your settings.

To have tring itself running after a reboot:

```sh
tring autostart on      # flags after `on` are passed to the daemon, e.g. --allow-origin …
tring autostart status
tring autostart off
```

This writes a systemd user unit on Linux, a LaunchAgent on macOS, or a `.cmd` in the
Startup folder on Windows, with the `PATH` you ran it from so the tiles find `claude`
and your tools. It is enabled for your next login, not started, since tring is usually
running already. A file at that path that tring did not write is left alone.

## Dropping files on a terminal

Drag a screenshot, a spreadsheet or any other file onto the centre terminal and its path is typed into the prompt,
the way dropping a file on any other terminal types one. Claude Code reads the
path from there.

It cannot work the way a native terminal's does. A browser hands a dropped file
over as bytes and withholds its location by design, and that location would be
the wrong machine's anyway whenever you have the deck open on a phone or a laptop
across the room. So the bytes go to the daemon, which writes them down on the
machine the shell is actually running on and answers with the path it chose.

- Any file up to 10MB. An image (PNG, JPEG, GIF, WebP) is named by its first
  bytes, not by what the browser called it; anything else keeps its own name,
  cut down to letters, digits, `.`, `-` and `_`, so Claude can tell a `.xlsx`
  from a `.csv`.
- Every file lands under `~/.config/tring/uploads` behind a random prefix, so
  no name a client sends can point anywhere else.
- The last 20 are kept. The directory is emptied when the daemon stops.
- The upload goes through the same token as the rest of the API.

Pasting works the same way. Ctrl+V with a screenshot on the clipboard uploads it
and types the path; text pastes as it always did. On a phone, where there is no
Ctrl+V and nothing to long-press, the switcher bar has a paste button: it reads
the clipboard — iOS shows its own "Paste" bubble to tap, Android asks once — and
types text or uploads an image accordingly. If the browser will not hand the
clipboard over, a sheet with a box to paste into opens instead.

The phone has nothing to drag a file from either, so the bar also has an attach
button. It opens the phone's own picker: take a photo, choose one from the
library, or pick any file. The file uploads and its path is typed, the same as a drop.

Next to it, a mic button types what you say. Tap it, talk, and tap it again: the
words show over the terminal while you speak and go into the prompt when you
stop, without pressing Enter. It uses the browser's own speech recognition, so it
works in Chrome on Android and Safari on iOS, but not in Firefox, where the button
is not shown. Unlike paste, it has no fallback on plain http: browsers only give
the microphone to an https page (or localhost).

## Orchestrator

With many agents running, finding the one that is waiting means hunting through the
ring. The **Orchestrator** tab (or `Ctrl+Space`, then `o`) turns the centre into an
inbox of everything the agents are waiting on, from every session in every project:

- **permission prompts** — the command, the file and the edit, or the tool input, with
  Allow, Deny (with an optional reason the agent sees) and *Answer in terminal*
- **questions** Claude asks with its AskUserQuestion tool — pick an option, or type
  your own answer
- **finished turns** — the agent's last message and a box to reply in

Answer and the card goes; the next one moves up. The ring keeps running around it, and
*Open* takes you to that session's terminal. On a card, `a` allows, `d` denies, `t`
hands it back to the terminal, `o` opens it, `1`–`9` picks an option, and `↑`/`↓` move
between cards.

The prompt also stays live in the session's own terminal, and whichever you answer first
wins — answer it there and the card clears itself.

It reads what the agents ask through Claude Code hooks, never by scraping the screen:

```
tring hooks install     # or the Install button the inbox shows when they are missing
tring hooks status
tring hooks uninstall
```

This adds a `tring-hook` entry per event to `~/.claude/settings.json` (keeping a backup
beside it, and leaving your own hooks alone). Outside a tring session `tring-hook` exits
at once and does nothing, so the same settings are safe for every `claude` you run.
Restart running `claude` sessions to pick the hooks up.

**AI approves routine prompts** (a switch in the inbox, off by default) has a small
Claude model (`claude -p --model haiku`, on your own Claude login) approve the prompts
that are plainly routine — tests, builds, edits inside the session's directory — so
only the rest reach you. It can only approve or leave a card for you; it never denies,
never answers a question and never replies for you. Some things always come to you
without the model being asked: `rm -r`/`-f`, `sudo`, `git push`/`reset --hard`,
publishing, deploys, `kubectl`/`terraform`, anything mentioning production, secrets and
`.env` files, paths outside the session's directory, MCP tools and plan approvals.
Every decision it makes is listed in the inbox with its reason.

Agents' messages, plans and questions are shown as formatted Markdown — bold, lists,
code, tables and links — never as raw asterisks. On a phone the Orchestrator also has a
button of its own in the bar under the tabs, with the count of cards waiting.

### Orchestrator agent

Optional, off by default. Tick **Agent** in the Orchestrator's header and the centre
becomes a Claude Code session of its own, with the cards in a column beside it. Drag
the bar between them to share the space: the terminal narrows or widens and refits as you
drag, and each side keeps a minimum. On a phone the cards are a band above the terminal
and the bar drags their height. The size is remembered per browser. A long reply or plan
on a card folds behind **Show all**. Instead of
typing into each tile, you tell it what you want:

> *Which tiles are on which branch? Ask the api tile to run its tests, and start a new
> tile in web to update the changelog.*

It works the tiles through tring's own MCP server, `tring`:

| Tool | What it does | Asks you first |
|---|---|---|
| `list_sessions` | every project and tile: status, repository, worktree and branch, whether it runs Claude, what it waits on, what it last said | no |
| `list_worktrees` | every worktree of each project's repository, its branch, and which tiles are in it | no |
| `find_work` | which tiles have been working on a topic, ranked by name, branch, conversation title, prompts, answers and edited files | no |
| `session_history` | a tile's Claude conversation: the prompts it was given, its answers, the files it edited | no |
| `read_session` | the last lines of a tile's terminal | no |
| `session_changes` | the uncommitted changes in a tile's worktree | no |
| `send_prompt` | a prompt to the Claude in a tile, as if you typed it there | no |
| `wait_for` | waits until tiles finish, then reads their answers | no |
| `create_session` | a new tile running Claude, optionally in a worktree for a branch, with an optional first prompt | yes |

**Which tile?** Say what the work is, not where it is — *"make the reporting box
green"* — and it goes to the tile that has been working on the reporting box, which
already has the context. tring reads each tile's own Claude Code transcript (the path
every hook reports) for Claude's title for the conversation, the prompts it was given and
the files it edited, so a tile is found by what it has been doing even after its work is
committed and its screen has moved on. The repositories an agent has edited and read in
count too, so a Claude started in your home directory that has spent the day in one
repository is found as working in that repository. When two tiles match about equally, or none
clearly does, the agent asks you which rather than guessing.

**Worktrees.** The agent works one branch, one worktree, one agent. A tile is placed
where its *agent* is working — every Claude Code hook reports that directory — so a
Claude that moved into a worktree (`claude --worktree`, or its own `cd`) is seen there,
not in the directory its shell started in. Tiles sharing a worktree are flagged, and
sending work to one while another agent is busy there comes back with a warning.
`create_session` with a `branch` reuses the worktree that already has it checked out, or
runs `git worktree add` (checking out the branch, or creating it from `base`). New
worktrees go beside your existing ones; with none to copy, in `<repo>.worktrees/`
next to the repository. Tell the agent otherwise in its `CLAUDE.md` (below).

It talks to agents and nothing else. It never types into a plain shell, and never into a
tile that is waiting on a permission prompt or a question — those stay yours, in the
cards beside it, as before. What the agents in the tiles do is still governed by their
own permissions.

**It never does the work itself.** It allocates work to tiles and looks things up; "test
it in the browser" goes to the tile that owns the work. That is enforced, not just asked:
its workspace settings deny editing and writing files, browser and computer-use tools,
web fetch and search, and subagents, in every permission mode. It loads tring's MCP
server and no other (`--strict-mcp-config`). Its workspace runs in the default
permission mode even if yours is `auto`, so any shell command you have not allowed asks
you first.

To let it run a lookup without asking — a ticket tool, say — allow that command in
`~/.config/tring/orchestrator/.claude/settings.local.json`, which is yours and never
rewritten, and say how to call it in `CLAUDE.md` there. Use the literal path with
backslashes doubled (Claude Code never pre-approves a command with `$HOME` in it), and the
shell the tool expects:

```json
{ "permissions": { "allow": ["PowerShell(node \"C:\\\\Users\\\\me\\\\tools\\\\tickets.mjs\":*)"] } }
```

The agent lives in `~/.config/tring/orchestrator`, which tring rewrites on every start
(`TRING.md` holds its instructions; add your own to `CLAUDE.md` there, which is kept).
The first time it opens, Claude Code asks whether to trust that folder and lists the
eight tools it pre-approves; say yes. Its conversation survives a restart of tring. If you quit
its Claude, the panel offers *Start again* or *New conversation*. Untick **Agent** and the
Orchestrator is the inbox it always was.

It needs the hooks (`tring hooks install`): they are how it knows which tiles run Claude
and when an agent has finished.

### Multi-PR workflow

For a complex feature or bug fix, built by several agents as small, tested, reviewed units,
landed the way that suits the ticket: independent PRs, a stack, or one PR of their commits.
Switch it on in **Settings → Workflow → Multi-PR workflow** (off by default; off, nothing
of it runs or shows). The orchestrator agent restarts in the same conversation to pick up
its ticket tools.

Then tell the orchestrator *work on ticket CHV-3193* (or describe the work). It looks the
ticket up the way it already does (or asks you to paste it), works out which local repos
it touches, and calls `start_ticket`. tring opens a tab for the ticket without moving your
view, and in it:

- A **planner** (read-only) splits the ticket into 1–16 small units (aim: 100–400 changed
  lines each): each with its scope, the files only it may edit, the interfaces it provides
  and uses, its tests and acceptance criteria. It also **recommends how they land**, with a
  line each on coupling, file overlap, size, repos, review load and shipping. tring keeps
  its own local tickets (`<KEY>-1`, `<KEY>-2`… under `~/.config/tring/tickets/`); it never
  writes to your tracker.
- **You choose, on every plan card**, with one *Approve plan* under a strategy picker
  (the planner's pick marked ★; your Settings default pre-selected):

  | | Independent PRs | Stacked PRs | Single PR |
  | --- | --- | --- | --- |
  | For | units that do not depend on each other | layers that build on each other | tightly coupled or small changes, or one PR per ticket |
  | Branches | each off the base | each on the unit below | local only; tring makes one branch |
  | PRs | one per unit, into the base (or a feature branch and one final PR) | one per unit, on the one below | one per repo, a commit per unit |
  | Merge | any order | bottom up | once |
  | Base moves | only a unit that would conflict is rebased | the stack is restacked bottom up | tring re-assembles |

  A pick the plan does not fit (independent PRs for units that depend on each other)
  reads *(re-plans)*: the planner reshapes the plan for it, and you choose again.
- A **coder** per unit, in its own worktree. Units commit their interfaces first; the ones
  using them start once those exist and code against the plan.
- A **fresh reviewer** per review round, read-only, using a code-review skill if you have
  one. A high or medium finding holds the unit only with proof (a failing command, or a
  line it changed); one already on the base becomes a follow-up instead. Each held one is
  a card: *Fix* (the coder looks into it, and may decline it with a reason) or *Skip with
  reason…*. A review stands across a rebase as long as the unit's change has the same
  `git patch-id`.
- An **integration check** per repo once its units are all reviewed: tring merges them
  onto the base (or, for a single PR, assembles one commit per unit) in a worktree of its
  own, and a read-only **integrator** runs every unit's tests and the full suite there.
  Pushes wait for it; a failure is a card that sends it to the unit that should fix it.
- *Push* is yours to click. Coders push their units and tring opens each PR itself; a
  single PR tring pushes and opens on its own (see
  [Pull requests](#pull-requests-github-and-bitbucket)). You merge; tring follows the
  merge and CI, and keeps a stack's PRs pointed at the right base. When it is done,
  *Clean up…* offers to remove the tab, worktrees and branches, ticking only what is safe
  and never forcing git.

The rules are enforced, not just asked for: each tile runs `claude --permission-mode
auto` with its own settings, and tring's hook denies an edit outside the PR's files, any
push before you click Push, and any merge. Agents report through a `tring-stack` MCP
server that only their own token opens, and a "tests pass" counts only for a committed
HEAD. At most *Agents per ticket* (4–16) work at once, and none start while the usage
panel shows a limit at 90 % or more. The ticket's feature card (pinned at the top of the
inbox, on the phone too) shows its progress and checklist; the tab shows a work view: a
stack joined bottom up, independent units side by side, or a single PR's commits, each
repo ending with its integration check.

Settings → Workflow also sets the default strategy, the final combined PR for independent
PRs, the integration check, and a model and effort for each role (planner, coders,
reviewers, integration checks; each tile starts with `claude --model … --effort …`).

### Pull requests: GitHub and Bitbucket

The agents never hold a forge token and never open, edit or merge a PR; tring does the
opening and retargeting, and only reads the rest. It knows the forge from each repo's
`origin`.

- **GitHub** goes through your own `gh` (`gh pr create --draft`, `gh pr edit --base`,
  `gh pr view` for the merge and checks).
- **Bitbucket Cloud** goes through its REST API with a scoped
  [API token](https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/)
  you create for tring: *Create API token with scopes*, app Bitbucket, scopes
  `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`. Put it in
  `~/.config/tring/bitbucket.json` (keep it to yourself: `chmod 600`):

  ```json
  { "token": "ATATT…", "email": "you@example.com" }
  ```

  With `email` (your Atlassian account email) the token goes as basic auth; without it,
  as a bearer token, which also suits a repository or workspace access token. Or set
  `TRING_BITBUCKET_TOKEN` (and `TRING_BITBUCKET_EMAIL`) for the daemon. It is read on
  each use, so no restart is needed; Settings → Workflow says whether tring has one.
  Builds on the PR (Pipelines or any CI that posts commit statuses) go on the checklist.
- **Without a token** (or when `gh` fails), the push is still recorded and the card gives
  you the link to open the PR yourself. A merge is then seen once the branch is in the
  base on `origin` (a merge commit or fast-forward); a squash merge needs *Mark merged*.

## Claude Code

`tring hooks install` (see [Orchestrator](#orchestrator)) includes a Stop hook, so
a tile turns green the instant Claude ends its turn. To do only that by hand, add a
`Stop` hook to `~/.claude/settings.json` so a tile turns green the
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
