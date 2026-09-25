# Diff viewer — design

**Date:** 2026-09-25
**Status:** approved in chat, awaiting spec review

## Goal

See the uncommitted changes of a session's working directory beside its
terminal, in a panel the user can make wider or thinner. Modelled on Claude
Code's own `/diff` panel, but owned by tring: it works for any program in the
slot, not only Claude, and its width is under the user's control rather than
derived from the terminal's column count.

## Decisions

| Question | Choice |
|---|---|
| Compare against | Uncommitted: `git diff HEAD` plus untracked files |
| Freshness | Poll every ~2s, only while the panel is open |
| Layout | File list with +/- counts on top, every file's diff stacked below; clicking a file scrolls to it |
| Entry point | A **Diff viewer** button in the tile's right-click session dialog |
| Which session | Always the focused (centre) session; choosing it on another tile focuses that tile |
| Phones | Hidden under `MOBILE_QUERY` |

Out of scope (add when asked): syntax highlighting, other compare bases
(since session start, branch vs default branch), sending selected lines to
Claude, right-click menu on the centre terminal.

## Server

### Route

`GET /api/sessions/:id/diff` — same token and origin checks as every other
`/api/` route; matched the way `/api/sessions/:id/done` is.

- `404 { error: 'no such session' }` if the id is unknown.
- Runs in `session.cwd` (the live directory read from `/proc`, so a `cd`
  inside the shell is followed).
- `200 { cwd, files, truncated }` where
  `files: { path: string; added: number; removed: number; patch: string }[]`,
  sorted by path.
- `200 { cwd, error: 'not a git repository' }` when `cwd` is outside a repo —
  a state to render, not a failure. Same for a repo with no commits yet
  (`HEAD` missing): untracked files are still listed.

### Git invocation

`execFile('git', args, { cwd, maxBuffer })` — no shell, arguments never
interpolated.

1. `git -c core.fsmonitor=false diff HEAD --no-ext-diff --no-textconv --no-color --no-renames`
2. `git -c core.fsmonitor=false ls-files --others --exclude-standard -z`

Each untracked file is reported as all-added: its lines read from disk,
`removed: 0`, patch built as `+`-prefixed lines. Binary content (a NUL in the
first 8KB) gets `patch: ''` and a `binary` marker in the client.

**Why the flags:** a repository's own `.git/config` can make git run programs
(`diff.external`, textconv drivers, `core.fsmonitor`). A panel that polls every
two seconds must not quietly execute whatever a cloned repo configured.

### Limits

Total patch text is capped at 1 MB. Past the cap, remaining files are listed
with counts and empty patches, and `truncated: true` is set. `maxBuffer` is
set above the cap so git's own output never throws for size.

### Tests (`packages/server/test/http.test.ts`)

Against a temporary repo created with `git init` in the test:

- a modified tracked file shows correct `added`/`removed` and patch text;
- an untracked file shows as fully added;
- a non-repo directory returns the `not a git repository` state;
- an unknown session id returns 404;
- output over the cap sets `truncated`.

## Web

### Entry point

`openSessionDialog` (`overlay.ts`) gains a fourth callback and a button,
**Diff viewer** / **Hide diff viewer**, placed with Delete on the left of the
actions row. `sessionMenu` (`main.ts`) passes a handler that focuses the
session if it is not already focused, then toggles the panel.

### Panel (`packages/web/src/diff-panel.ts`)

One module exporting a small class, wired from `main.ts`:

- `open()`, `close()`, `toggle()`, `isOpen`, `setSession(id | null)`.
- `.focus-cell` becomes a flex row: the xterm host, a vertical drag handle,
  the panel. The xterm host takes the remaining width and `FocusTerminal`
  refits on resize (it already refits on container size changes).
- **Resize:** pointer drag on the handle sets the panel width in px, clamped
  to 240px … 75% of the cell. Width and open/closed state persist per browser
  in `localStorage`, wrapped in try/catch like the other per-browser settings.
- **Polling:** while open and a session is set, fetch every 2s via the
  existing `api()` helper; skip a tick if one is in flight; stop on close.
  Re-render only when the response text differs from the last one.
- **Rendering:** header `N files changed +A -R` and `✕`; file list rows
  (path, `+A -R`); then each file's diff with old/new line numbers, green
  added and red removed lines, hunk headers dimmed. Clicking a row scrolls
  its diff into view. States: loading, `not a git repository`, no changes,
  error message, truncated note.
- Hidden entirely on phones via `MOBILE_QUERY`.

### Styling

In `style.css`, using the existing tokens (`--line`, `--mint`, `--red`,
`--mono`, …); no new colours.

### Tests

The patch-to-rows parsing (line numbering across hunks) is the one piece of
non-trivial client logic; it lives as a pure function in `diff-panel.ts` with
one test file, `packages/web/test/diff-panel.test.ts`, beside the existing web
tests (run by the root `vitest run`). Width clamping is a pure function
tested there too.
