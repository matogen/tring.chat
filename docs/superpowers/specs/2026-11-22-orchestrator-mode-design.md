# Orchestrator mode: one inbox in the centre for every agent's questions

## Context

With 5–16 agents running, you have to jump between tiles to find the one that is waiting and to see *what* it wants. Orchestrator mode turns the centre panel into an inbox. Every permission prompt, question and "finished, what next?" from the other sessions shows up there as a card that you can answer without switching. A supervising AI (off by default) answers the low-risk permission prompts itself and sends you the rest.

Research findings that shape the design:
- **Read what the agent asks through Claude Code hooks, not the screen.** Tools that read the screen (claude-squad, ccmanager) keep breaking: ccmanager made about 15 fixes to its Claude detector in 2026, and Omnara gave up on its wrapper. Hooks give the exact data:
  - `PermissionRequest`: `tool_name`, `tool_input`. It can return `allow` or `deny`. In the main session the hook and the terminal dialog run in parallel and the first answer wins, so the terminal stays usable.
  - `PreToolUse` on `AskUserQuestion`: can answer through `updatedInput.answers`. This blocks the terminal question while it waits.
  - `Stop`: gives `last_assistant_message`.
  - `Notification`: `notification_type` such as `permission_prompt` or `idle_prompt`.
- **Stale prompts are the main risk.** Claude Code has no "prompt resolved" event. So each card gets a server ID and is tied to the open hook request. If that request closes because you answered in the terminal, the card disappears. Never type keystrokes into a terminal based on an old screen.
- **tring already has most of what's needed:**
  - every PTY gets `TRING_SESSION_ID`, `TRING_URL` and `TRING_TOKEN` (`packages/server/src/session.ts:112-121`)
  - there is a bearer-auth HTTP API, including `POST /api/sessions/:id/done` (`packages/server/src/http.ts:202`)
  - ws `input` to any session id, not just the focused one (`packages/server/src/ws.ts:144`)
  - a headless screen buffer per session (`session.ts:135`)
  - centre-panel patterns: the diff panel (`packages/web/src/diff-panel.ts`) and the usage view swap (`main.ts:546-570`)
- **Name.** "Orchestrator mode" is the name in the UI. For marketing, the earlier research says to avoid "orchestrator", so it will be pitched as "answer every agent from one place".

## Design

### 1. Hooks (`tring-hook` bin + one-click install)
- New file `packages/server/src/hook-cli.ts`, built to a second bin, `tring-hook`, in `packages/server/package.json`. It is a tiny Node script: `tring-hook <Event>` reads the hook JSON from stdin.
  - It **exits 0 at once, printing nothing, when `TRING_SESSION_ID` is unset**, so Claude outside tring is unaffected.
  - Otherwise it POSTs `{event, payload}` to `$TRING_URL/api/sessions/$TRING_SESSION_ID/hook` with `Bearer $TRING_TOKEN`, waits for the reply, and prints the hook JSON the server returns. Any failure (tring down, timeout) means exit 0 with no output, so Claude falls back to its normal dialog.
- Events: `PermissionRequest`, `PreToolUse` with matcher `AskUserQuestion`, `Notification`, `Stop`, `UserPromptSubmit` and `PostToolUse` (the last two clear stale cards).
- New file `packages/server/src/hooks-install.ts`, used by `tring hooks install|uninstall|status` (subcommand dispatch in `index.ts`/`args.ts`) and by `POST /api/hooks/install`:
  - It merges entries into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) without touching anything else, and backs up the file first.
  - Each entry is marked by its command string `tring-hook`, so install can run twice safely and uninstall removes exactly what it added.
  - It replaces the manual Stop hook that the README documents. The existing `done` endpoint stays.
- A settings-dialog row (`overlay.ts` `openSettingsDialog`) shows the hook status, with an Install button.

### 2. Inbox on the daemon (`packages/server/src/inbox.ts`, pure and unit-tested)
- An item is `{id, sessionId, kind: 'permission'|'question'|'reply', tool?, input?, questions?, message?, createdAt}`.
- `POST /api/sessions/:id/hook` in `http.ts`:
  - **PermissionRequest and AskUserQuestion:** create an item and **hold the HTTP response open** until it is answered (via ws or the auto-answerer), the request closes, or the session exits. On close or exit, drop the item.
  - **Stop:** create a `reply` item from `last_assistant_message` and reply at once. It is dropped on any input to that session or when its status becomes busy.
  - **UserPromptSubmit and PostToolUse:** drop that session's open items (stale guard).
  - **Notification:** just call `s.hook()` so the tile turns green, as today.
- The hook response is built per event (shapes as in the hooks reference):
  - Permission: `hookSpecificOutput.decision.behavior` set to `allow` or `deny`, plus `message`. "Always allow" is not offered, because "Don't ask again" rules have leaked secrets.
  - Question: `permissionDecision: 'allow'` with `updatedInput` set to the original questions plus `answers`.
  - "Answer in terminal": returns nothing, which releases the question to the TUI.
- Protocol (`packages/shared/src/protocol.ts`):
  - Server → client `inbox {items}`, sent to every authed client on change, like `status` is (`ws.ts:215`).
  - Client → server `answer {itemId, decision: 'allow'|'deny'|'terminal', answers?, message?}`.
  - Client → server `reply {itemId, text}`. The daemon checks the item still exists and the session is still `done`, then writes the text with bracketed paste plus `\r` via `Session.write`.
- Sessions that are not Claude (shells, other agents) get no cards. Their tiles still turn green as today. Codex hooks come in a later version.

### 3. Centre panel (`packages/web/src/inbox-panel.ts`)
- A new `InboxPanel` mounted in `focusCell`, built like `DiffPanel`. In orchestrator mode it covers `termHost`, which stays attached so the WebGL canvas survives. The ring of thumbnails stays visible around it.
- Turn it on with a new picker key (`O`, in `packages/shared/src/keymap.ts`) and a tab-bar button (`project-bar.ts`). The choice is saved in localStorage as `tring.orchestrator`.
- Cards are oldest first and show the session name and slot in its tint, the tool and the command or file path, or the question with its options, or the agent's last message with a reply box. All text goes in through `textContent`.
- Buttons: Allow / Deny (with an optional reason) / Answer in terminal / Open. After an answer the card disappears and the next one moves up. You stay in the inbox. Open focuses that session (the existing `focusSession`) and leaves orchestrator mode.
- Keys:
  - `A` allows, `D` denies, `1`–`9` picks an option, `Enter` sends a reply and `Esc` leaves the box.
  - **The keys only act on the card that has focus**, and the card shows a "new" flash for 300ms before it accepts keys, so a card that appears as you type can't take the keystroke.
- A tile with an open card gets a "?" badge. A `tring()` chime plays when a card arrives (reuses `sound.ts`). The document title counts open cards.
- It is also reachable in the phone layout: the switcher row opens the inbox.

### 4. AI auto-answer (off by default, `packages/server/src/auto-answer.ts`)
- **Scope:** permission cards only. Questions and replies always go to you. The AI only ever **allows or escalates to you, never denies.**
- **Rules come first and are pure, so they are unit-tested:**
  - **Always sent to you:** `AskUserQuestion`; `ExitPlanMode`; any path outside the session cwd; Bash commands matching a deny list (`rm -r`, `sudo`, `git push`/`reset --hard`, `curl|wget … | sh`, writes to `~/.ssh`, `.env`, credential files, package publish); MCP tools from servers that aren't allowlisted.
  - Anything else goes to the classifier.
- **Classifier:** the daemon runs `claude -p --model haiku --output-format json` with a fixed prompt holding the tool, input, cwd and recent screen text. It does this through `spawn`, the way `usage.ts:264` already does, and the child has no `TRING_SESSION_ID`, so it doesn't trigger tring's hooks. It must return `{"verdict":"allow"|"ask","reason"}`. Bad output, an error or a wait over 15s means ask.
- The settings dialog has the toggle. Every auto-decision appears in an inbox "History" list with its reason, and briefly on the tile ("auto: npm test").

### Build order (each step ships on its own)
1. Hooks, the inbox server and the protocol, with tests.
2. The inbox panel UI.
3. Auto-answer.

A design spec for each step goes in `docs/superpowers/specs/`, following the existing specs.

## Verification
- `npm test` and `npm run typecheck` from the repo root.
- **New unit tests:**
  - `inbox.ts`: item lifecycle and stale clearing.
  - `hooks-install.ts`: merges into existing settings, install twice changes nothing, uninstall removes only tring's entries.
  - `auto-answer` rules: a table of commands to expected verdicts.
  - Hook response shapes.
- **New integration test** (`packages/server/test/http.test.ts` pattern): POST a PermissionRequest hook, answer over ws, and check the held response body. Then check that closing the request drops the item.
- **By hand:**
  - Run `tring hooks install`, start two Claude sessions, and ask each to run a shell command.
  - Both cards appear in the centre. Allowing one runs it. Answering the other in its own terminal removes its card.
  - An `AskUserQuestion` is answered from a card. A finished session's reply box sends a follow-up prompt.
  - With auto-answer on, `npm test` is auto-allowed and `git push` reaches you.
  - Run `claude` outside tring and confirm the hooks do nothing.
