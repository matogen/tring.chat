import { describe as group, it, expect } from 'vitest'
import type { InboxItem } from '@tring/shared/protocol'
import { age, answersFor, clip, describe } from '../src/inbox-view.ts'

const perm = (tool: string, input: Record<string, unknown>): InboxItem =>
  ({ id: 'i', sessionId: 's', kind: 'permission', createdAt: 0, tool, input })

group('describe', () => {
  it('shows a command with the agent\'s reason', () => {
    expect(describe(perm('Bash', { command: 'npm test', description: 'Run the tests' }))).toEqual({
      heading: 'Run a command', tool: 'Bash', body: 'npm test', mono: true, note: 'Run the tests',
    })
  })
  it('shows an edit as removed and added lines', () => {
    const t = describe(perm('Edit', { file_path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' }))
    expect(t.body).toBe('a.ts\n\n- x = 1\n+ x = 2')
  })
  it('names an MCP tool by its server', () => {
    expect(describe(perm('mcp__github__create_pr', { title: 't' })).heading).toBe('Use github tool')
  })
  it('falls back to the raw input', () => {
    expect(describe(perm('Glob', { pattern: '**/*.ts' })).body).toBe('{\n  "pattern": "**/*.ts"\n}')
  })
})

group('clip', () => {
  it('says how much it cut', () => {
    expect(clip('abcdef', 4)).toBe('abcd\n… 2 more characters')
    expect(clip('abc', 4)).toBe('abc')
  })
})

group('answersFor', () => {
  const qs = [
    { question: 'DB?', options: [{ label: 'PG' }, { label: 'SQLite' }] },
    { question: 'Extras?', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Cache' }] },
  ]
  it('waits until every question is answered', () => {
    expect(answersFor(qs, new Map([[0, new Set(['PG'])]]), new Map())).toBeNull()
  })
  it('joins multi-select picks and prefers typed text for a single choice', () => {
    expect(answersFor(qs,
      new Map([[0, new Set(['PG'])], [1, new Set(['Auth', 'Cache'])]]),
      new Map([[0, 'MySQL']]),
    )).toEqual({ 'DB?': 'MySQL', 'Extras?': 'Auth, Cache' })
  })
})

group('age', () => {
  it('rounds to the largest unit', () => {
    expect([age(4000), age(125_000), age(7_300_000)]).toEqual(['4s', '2m', '2h'])
  })
})
