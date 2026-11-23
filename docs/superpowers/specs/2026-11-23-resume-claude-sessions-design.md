# Plan: resume Claude sessions after a tring or PC restart

## Context
When the daemon restarts, every tile comes back as a plain shell in its last directory (restore the place, not the command). A Claude conversation that was running in a tile is lost from view: the user has to find it with `claude --resume` by hand, per tile. Goal: after a tring restart or a reboot, each tile that was running Claude reopens the same conversation by itself.

## Decisions (2026-11-23)
- Resume by itself, no button (owner). Claude idles until prompted, so this is safe. Other commands (dev servers) still never auto-run.
- Claude only; Codex later (owner).
- `tring autostart on|off|status` (owner).
- The conversation id comes from the `SessionStart` hook payload (`session_id`, `cwd`), through the hooks orchestrator mode already installs. Exact per tile, unlike `claude --continue`, which picks the newest conversation in a directory and would give two tiles in one repo the same one. (agent)
- `SessionEnd` clears it only for reasons the user caused (`prompt_input_exit`, `logout`, `clear`). A daemon stop or reboot SIGTERMs Claude too (`KillMode=control-group`), which ends with reason `other`, and must not forget the conversation. The ProjectManager also stops saving once shutdown starts. (agent)
- The resume is typed into an interactive shell after rc files run (`claude --resume <uuid>`), not exec'd, so quitting Claude leaves the tile a shell, as it was. The id must match a UUID before it is typed. (agent)
- Autostart runs `tring --no-open` with the PATH captured at install time, so sessions find `claude`, node and tools. An existing unit/agent not written by tring is left alone and reported. (agent)

## Build
1. **Record the conversation per tile**: `hooks-install.ts` adds `SessionStart`, `SessionEnd`; `hook-route.ts` handles them through a new `HookSession.claude(...)`; `session.ts` holds `claudeSession {id, cwd}`; `project-manager.ts` persists it as `claude` on `PersistedSession`. Points: 3
2. **Resume on restore**: `session.ts` option `resume`, typed after the rc grace in the conversation's cwd; `project-manager.ts` passes it on activate and adds a `closing` flag; `index.ts` shutdown sets it first. Points: 3
3. **Autostart**: new `autostart.ts` (systemd user unit / LaunchAgent / Startup `.cmd`), `tring autostart` in `index.ts` and `args.ts` help. Points: 5
4. **Docs**: README section, this spec. Points: 1

## Build order
Wave 1 = 1, 2 · wave 2 = 3, 4. Branch `feature/resume-claude-sessions`, PR to main for Ruan.

## Verification
- `npm test`, `npm run typecheck`.
- Unit: hook routing for SessionStart/SessionEnd reasons, persistence round trip, UUID guard, resume typed only once, closing blocks saves, autostart file contents and the refuse-foreign-unit rule.
- E2E on a test daemon: start `claude` in a tile, tell it a number, SIGTERM the daemon, start it again, the tile is back in the same conversation and knows the number.

## Risks
- Claude launched with flags (`--model`, permission mode) resumes with plain `claude --resume`; settings.json defaults apply.
- No hooks installed → nothing to resume; the inbox banner already asks for the install, and status now reports the two new events as missing.

## Only Cobus can do
- `tring hooks install` again (adds the two new events), restart Claude sessions once.
- Your hand-made `~/.config/systemd/user/tring.service` already autostarts tring; `tring autostart on` will leave it alone.

## Not in this plan
Codex resume. A visible "resumed" marker on the tile.
