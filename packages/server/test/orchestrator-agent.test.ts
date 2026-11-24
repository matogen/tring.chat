import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DENIED, OrchestratorAgent, PRE_ALLOWED } from '../src/orchestrator-agent.ts'
import type { Session } from '../src/session.ts'

/** Starts the agent with a stand-in for the PTY, and keeps the command it was given. */
function agentIn(dir: string): { agent: OrchestratorAgent; commands: string[] } {
  const commands: string[] = []
  const agent = new OrchestratorAgent({
    dir: path.join(dir, 'orchestrator'),
    statePath: path.join(dir, 'orchestrator-agent.json'),
    url: 'http://127.0.0.1:7331',
    token: 'secret-token-for-tests',
    scrollback: 100,
    idleMs: 1000,
    mcpScript: path.join(dir, 'tring-mcp.js'),
    node: process.execPath,
    spawn: (o) => {
      commands.push(o.command ?? '')
      return { id: o.id, tracker: { status: 'idle' }, claude: null, tick: () => {}, dispose: () => {} } as unknown as Session
    },
  })
  return { agent, commands }
}

describe('the orchestrator workspace', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('takes away the tools that do work, and asks before anything else', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tring-agent-'))
    const { agent } = agentIn(dir)
    await agent.setEnabled(true)
    const settings = JSON.parse(readFileSync(path.join(dir, 'orchestrator', '.claude', 'settings.json'), 'utf8'))
    expect(settings.permissions.defaultMode).toBe('default')
    expect(settings.permissions.allow).toEqual(PRE_ALLOWED)
    expect(settings.permissions.deny).toEqual(DENIED)
    // The specific failure: it tested in the browser itself.
    for (const t of ['Edit', 'Write', 'mcp__claude-in-chrome', 'WebFetch', 'Agent']) expect(DENIED).toContain(t)
    // Its own tools stay usable, and nothing it needs to delegate is denied.
    expect(DENIED.some((d) => d.startsWith('mcp__tring'))).toBe(false)
    agent.dispose()
  })

  it('starts Claude with tring\'s MCP server and no other', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tring-agent-'))
    const { agent, commands } = agentIn(dir)
    await agent.setEnabled(true)
    expect(commands).toEqual(['claude --strict-mcp-config --mcp-config tring-mcp.json'])
    agent.dispose()
  })

  it('tells the agent it never does the work, and leaves the user\'s own files alone', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tring-agent-'))
    const ws = path.join(dir, 'orchestrator')
    mkdirSync(path.join(ws, '.claude'), { recursive: true })
    writeFileSync(path.join(ws, 'CLAUDE.md'), '@TRING.md\n\nmine\n')
    writeFileSync(path.join(ws, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(node x:*)"]}}\n')
    const { agent } = agentIn(dir)
    await agent.setEnabled(true)
    const tring = readFileSync(path.join(ws, 'TRING.md'), 'utf8')
    expect(tring).toMatch(/## You never do the work yourself/)
    expect(tring).toMatch(/use the browser to test/)
    // The old loophole: "Do not edit project files yourself unless the user asks."
    expect(tring).not.toMatch(/project files yourself unless the user asks/)
    expect(readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8')).toBe('@TRING.md\n\nmine\n')
    expect(readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8')).toMatch(/node x/)
    agent.dispose()
  })
})
