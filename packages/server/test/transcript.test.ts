import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findTranscript, parseTranscript, readTranscript } from '../src/transcript.ts'

/** Lines shaped like Claude Code's own transcript, trimmed to what is read. */
const line = (o: object): string => JSON.stringify(o)
const LINES = [
  line({ type: 'permission-mode', permissionMode: 'default' }),
  line({ type: 'user', origin: { kind: 'human' }, timestamp: '2026-11-24T08:00:00Z', message: { role: 'user', content: 'Make the reporting box green' } }),
  line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Looking at ReportBox.' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/ReportBox.tsx' } }] } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done: it is green.' }] } }),
  line({ type: 'ai-title', aiTitle: 'Reporting box colour' }),
  // Not prompts: a task notification, a slash-command echo, a meta line, a subagent.
  line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>x</task-notification>' } }),
  line({ type: 'user', origin: { kind: 'human' }, message: { content: '<command-name>/clear</command-name>' } }),
  line({ type: 'user', isMeta: true, message: { content: 'Caveat: meta' } }),
  line({ type: 'user', isSidechain: true, message: { content: 'subagent prompt' } }),
  line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent answer' }] } }),
  'not json at all',
  line({ type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'Now commit it' }] } }),
]

describe('parseTranscript', () => {
  it('keeps people\'s prompts, the agent\'s words and its edits, folded into turns', () => {
    expect(parseTranscript(LINES)).toEqual({
      title: 'Reporting box colour',
      turns: [
        { role: 'user', text: 'Make the reporting box green', at: '2026-11-24T08:00:00Z' },
        { role: 'assistant', text: 'Looking at ReportBox.\n\nDone: it is green.', at: null, files: ['/r/ReportBox.tsx'] },
        { role: 'user', text: 'Now commit it', at: null },
      ],
    })
  })
})

describe('reading transcripts from disk', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tring-tx-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const id = '0f3c6a52-1d2e-4c7b-9a8e-123456789abc'

  it('finds a conversation by id under any project directory, and reads it', async () => {
    mkdirSync(path.join(dir, 'C--src-app'))
    const file = path.join(dir, 'C--src-app', `${id}.jsonl`)
    writeFileSync(file, LINES.join('\n') + '\n')
    expect(await findTranscript(dir, id)).toBe(file)
    expect(await findTranscript(dir, 'not-a-uuid')).toBeNull()
    const t = await readTranscript(file)
    expect(t?.title).toBe('Reporting box colour')
    expect(t?.turns).toHaveLength(3)
    expect(t?.partial).toBe(false)
  })

  it('rereads only when the file changes', async () => {
    const file = path.join(dir, 'C--src-app', `${id}.jsonl`)
    const first = await readTranscript(file)
    expect(await readTranscript(file)).toBe(first)
    writeFileSync(file, LINES.join('\n') + '\n' + line({ type: 'user', origin: { kind: 'human' }, message: { content: 'One more' } }) + '\n')
    expect((await readTranscript(file))?.turns.at(-1)?.text).toBe('One more')
  })

  it('is null for a missing file', async () => {
    expect(await readTranscript(path.join(dir, 'nope.jsonl'))).toBeNull()
  })
})
