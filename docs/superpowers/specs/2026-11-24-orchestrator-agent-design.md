# Orchestrator agent: a Claude in the centre that drives the tiles

## Context
Orchestrator mode put every agent's prompts in one inbox, but work still meant typing into each tile. Goal (owner): an orchestrator you type to, that can read every terminal, knows the branches they are on, prompts their agents and starts new tiles. Optional: off, orchestrator mode works exactly as before.

Shipped alongside, from the same request:
- Mobile: the pinned Orchestrator tab shrank to a blank button on a narrow bar (`min-width: 0` with flex-shrink). It no longer shrinks; the phone switcher also gets an Orchestrator button with the card count.
- Cards render agents' Markdown (`markdown.ts`: pure parser + textContent-only DOM builder, http(s) links only) instead of raw `**bold**`.
- A card arriving while you type in another card's reply box no longer steals focus: `render()` re-appended every card, and moving a node blurs it. It now only inserts cards that are new or out of place.

## Decisions (2026-11-24)
- **One global agent**, like the inbox: it sees every project. Not a ring slot; its own `Session` owned by `OrchestratorAgent` (`orchestrator-agent.ts`), reached by id through the same `focus`/`input`/`resize` messages (`Hub.find`).
- **Tools live in the daemon** (`orchestrator-tools.ts`, unit-tested with stubs). `tring-mcp` (`mcp-cli.ts`, bundled to `dist/tring-mcp.js`) is a stdio JSON-RPC relay to `GET /api/orchestrator/tools` and `POST /api/orchestrator/call`, behind the existing bearer token. No MCP SDK dependency.
- **It only talks to agents.** `send_prompt` refuses a tile without a Claude conversation (from the SessionStart hook) and a tile with an open permission/question card: typing there would land in a shell or in someone's dialog. Permission cards stay the user's.
- **Pre-approved**: `list_sessions`, `read_session`, `session_changes`, `send_prompt`, `wait_for` (workspace `.claude/settings.json`; Claude Code shows them in its trust prompt). `create_session` spawns processes, so Claude asks each time.
- **Workspace** `~/.config/tring/orchestrator`: `TRING.md` (instructions), `tring-mcp.json`, `.claude/settings.json`, `.token` (0600) rewritten each start; `CLAUDE.md` written once (`@TRING.md`) and left to the user. The command is `claude --mcp-config tring-mcp.json [--resume <uuid>]`, all relative, so nothing needs quoting for any shell.
- **Relay auth**: `--url` + `--token-file` written by the daemon win over inherited `$TRING_URL`/`$TRING_TOKEN` (found in testing: a shell inside another tring has that daemon's token).
- **Resume**: the agent's SessionStart hook records its conversation (no inbox cards for its own prompts: they are on screen). An exit within 10s of `--resume` means the conversation is gone; it starts fresh once.
- **First prompt of `create_session`** is typed only after the tile's SessionStart hook and 1.5s without output (30s limit). Otherwise the tool says it was not sent, rather than typing blind.
- **`wait_for`** finishes a tile on exit, an open card (needs the user), or not-busy with a Stop at or after its last prompt (`Session.promptedAt`/`stoppedAt`, set by UserPromptSubmit/Stop hooks and `send_prompt`); 15s grace for a prompt that never made it busy.
- `ProjectManager.create` no longer activates the project (`ensure` spawns a restored project's sessions without changing the view), so the agent starting a tile elsewhere does not move the user.

## Worktrees (owner: "very important in our workflow")
- **Where the work is**: every hook payload's `cwd` is kept as `Session.agentCwd` (cleared on SessionEnd). Git questions use it before the shell's cwd, so an agent that moved into a worktree (`claude --worktree`, a `cd`) is placed there. This also covers shells that never report a `cd` (PowerShell on Windows) for Claude tiles.
- **`git-worktrees.ts`**: `place(dir)` → worktree root, common git dir (repository identity), linked or main, branch; `worktrees(dir)` → `git worktree list --porcelain`; read-only calls with fsmonitor off. `git worktree add` runs as plain git (filters, hooks), because it is a checkout the user approved.
- **Tools**: `list_sessions` gives each tile `git {repo, branch, worktree, linkedWorktree}`, `agentCwd` when it differs, and `sameWorktreeAs`. New pre-allowed `list_worktrees`: per repository (project roots and tiles), each worktree with its branch and tiles. `session_changes` diffs the agent's worktree. `send_prompt` warns when another agent is busy in the same worktree.
- **`create_session` `branch`/`base`/`worktree_path`**: reuse the worktree that has the branch (warning if tiles are already in it), else `git worktree add` of the existing branch or `-b branch base`. Branch names go through `git check-ref-format --branch`; names and bases starting with `-` are refused. Default path: beside the existing linked worktrees when they share a parent, else `<parent>/<repo>.worktrees/<branch-slug>`.
- **Instructions** (`TRING.md`): one branch, one worktree, one agent; new parallel work gets its own; name branches like the existing ones; report branch and worktree; never remove, merge or push unasked.
- Verified on a real repository through the relay: agent move detected, reuse, new branch from `main` placed beside the existing worktree, bad name refused.

## Routing by topic ("change the reporting box to green")
- The record of what a tile is *about* is its conversation. Every hook's `transcript_path` is kept as `Session.transcript`; before one arrives (a restored tile), the transcript is found by conversation id under `~/.claude/projects/*/<id>.jsonl`.
- `transcript.ts` parses Claude Code's JSONL: people's prompts (`origin.kind: human`; tool results, task notifications, slash-command echoes, meta and sidechain lines dropped), the agent's text folded per turn, the files its Edit/Write/MultiEdit/NotebookEdit calls touched, and `ai-title`. Read whole up to 8 MB, else head 512 KB + tail 8 MB; cached by size and mtime.
- `list_sessions` adds `conversation {title, firstPrompt, recentPrompts}`. New pre-allowed tools: `session_history` (turns, optional `search`) and `find_work` (ranks tiles: words stemmed, stop words dropped, each word weighted by how few tiles mention it, name/branch/title/prompts/edits over agent text, recent turns doubled).
- A tile only counts as a match with every word in one place, or at least half of them in its name, branch, title, prompts or edits. Live testing found "payments page" landing on the tile whose agent wrote "login page"; now it says no tile clearly matches. Near ties (second within 75 % of the best) say so. `TRING.md` tells the agent to ask the user in both cases rather than guess.
- Verified with two real Claude tiles in their own worktrees, also after a daemon restart: reporting-box request → the reporting tile, login → the auth tile, payments → no clear match.

## Fixes after the first week (0.1.22)
- **Freeze when changing tabs**: switching project reset the socket's focus to none, which stopped the agent's output reaching that browser while keystrokes still reached the agent (reproduced on 0.1.21: the agent had `before-switch after-switch`, the screen showed `before-switch`). `Hub.keepFocus` keeps a socket on the agent, which is in no project, across `activateProject` and `deleteProject`.
- **Cards cut off**: `MAX_BODY` was 4 000 characters ("… N more characters"). Now 100 000, as a ceiling against a runaway Write, and any body taller than its box gets *Show all* / *Show less* (`expandable`, re-measured on resize).
- **Card column fixed width**: a drag handle like the diff panel's, width saved per browser (`tring.inboxWidth`), clamped to 240 px–75 %, terminal refitted on release. Hidden in the stacked phone layout.
- **Missed tile**: asked to "edit tring", the agent found no tile, though GENERAL/1 had spent the day editing tring from `C:\Users\User`. Transcripts now also record files read and shell commands; `workedIn` (list_sessions) and a strong `worked in` field (find_work) give the worktrees an agent actually worked in, found by walking up to `.git` without running git. Words no tile mentions no longer count against confidence, and a word only one tile has in its purpose fields is enough. Replayed on the real transcript: "Best match: GENERAL/1". A person's message starting with a tag (a paste) is no longer dropped as a system line. The agent is told not to scan the disk for repositories.

## Fixes (after 0.1.22)
- **Card column flowed over the terminal**: `fitTerminal` sent the PTY resize only `if (focusedId)`, so with the agent in the centre and no tile focused the agent's PTY never followed a drag, and the terminal refitted only on release. Now one path fits whatever `target()` is; a `ResizeObserver` on the terminal's box refits on every frame of a drag, of cards arriving, of the diff panel; the PTY gets one debounced resize. `split.ts` keeps minimums (cards 240 px, terminal 320 px; stacked 90/160 px), the stylesheet backs them, and on a phone the handle drags the band's height.
- **Phone and PC shared one size**: a PTY has one size, and `focus`/`resize` from any client set it, so the other device drew redraws meant for another width until its window was resized. `size-owner.ts`: the size follows the device in use (focus, click, window focus/visibility, key press, paste, window resize claim it); other clients are sent `size` and draw at exactly that size (`FocusTerminal.adopt`), with a note to fit back; claiming resizes the PTY and replays the screen. Input does not claim on the server: xterm's answers to a program's queries travel as input, so the device that just lost the size took it straight back (seen in testing). Trade-off against tmux's smallest-wins: no device is stuck at another's size, at the cost of a redraw on switching.
- **Tile not routed after a restart**: a resumed conversation's SessionStart reports `transcript_path` built from the *current* directory (verified: `C--Users-User\<id>.jsonl` while the file is under the directory the conversation began in); later events report the real one. tring trusted the hook's path, so an idle resumed tile had no title, prompts or workedIn until someone typed in it. `history()` now falls back to finding the transcript by the persisted conversation id (cached), and keeps the path that works. find_work also reads the tile's screen, as a strong field when there is no conversation to read.

## UI
- Inbox header: **Agent** switch (server-side, persisted in `orchestrator-agent.json`).
- Agent on + orchestrator open: centre terminal attaches to the agent (`main.ts` `target()`/`applyCentre()`); the inbox becomes a side column (`.inbox.beside`), on a phone stacked above the terminal. The focused tile is kept to return to; diff panel hidden.
- Agent exited: a note with *Start again* / *New conversation*.

## Verification
- `npm run typecheck`; `npx vitest run packages/server/test/orchestrator-tools.test.ts packages/web/test/markdown.test.ts` (21 + 12 tests). The rest of the suite has 29 failures on Windows that are the same on `main`.
- E2E on a throwaway daemon (port 7399, isolated `XDG_CONFIG_HOME`): MCP relay over stdio; `claude -p --mcp-config tring-mcp.json` lists tiles with branches; interactive agent answers through the tools; `create_session` with prompt → `wait_for` returns "pong"; follow-up `send_prompt` → "second"; `send_prompt` to a shell refused; focus kept while a card arrives; Markdown card rendered.

## Not in this plan
Answering permission cards from the agent. Codex tiles. Removing worktrees. Pushing events to the agent (it polls with `wait_for`). WSL shells with a Windows daemon (the MCP command is the Windows Node).
