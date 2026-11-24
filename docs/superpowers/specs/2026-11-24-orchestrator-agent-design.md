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

## UI
- Inbox header: **Agent** switch (server-side, persisted in `orchestrator-agent.json`).
- Agent on + orchestrator open: centre terminal attaches to the agent (`main.ts` `target()`/`applyCentre()`); the inbox becomes a side column (`.inbox.beside`), on a phone stacked above the terminal. The focused tile is kept to return to; diff panel hidden.
- Agent exited: a note with *Start again* / *New conversation*.

## Verification
- `npm run typecheck`; `npx vitest run packages/server/test/orchestrator-tools.test.ts packages/web/test/markdown.test.ts` (21 + 12 tests). The rest of the suite has 29 failures on Windows that are the same on `main`.
- E2E on a throwaway daemon (port 7399, isolated `XDG_CONFIG_HOME`): MCP relay over stdio; `claude -p --mcp-config tring-mcp.json` lists tiles with branches; interactive agent answers through the tools; `create_session` with prompt → `wait_for` returns "pong"; follow-up `send_prompt` → "second"; `send_prompt` to a shell refused; focus kept while a card arrives; Markdown card rendered.

## Not in this plan
Answering permission cards from the agent. Codex tiles. Worktree creation in `create_session`. Pushing events to the agent (it polls with `wait_for`). WSL shells with a Windows daemon (the MCP command is the Windows Node).
