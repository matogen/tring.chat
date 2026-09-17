import { describe, it, expect } from 'vitest'
import { browserAgentCommand } from '../src/protocol.ts'

describe('browserAgentCommand', () => {
  // The shim has already added the config by the time claude starts, so the
  // default is the command a person would have typed.
  it('is plain claude where the session PATH carries the shim', () => {
    expect(browserAgentCommand(null)).toBe('claude --permission-mode auto')
  })

  it('spells the config out where there is no shim to do it', () => {
    expect(browserAgentCommand('"$TRING_MCP_CONFIG"'))
      .toBe('claude --mcp-config "$TRING_MCP_CONFIG" --permission-mode auto')
  })

  // Driving a page is tool calls and nothing else. A Browser Agent tile that
  // stops for permission on the first one is asking a human to authorise the
  // thing the human just asked for.
  it('starts in auto mode either way', () => {
    for (const ref of [null, '%TRING_MCP_CONFIG%']) {
      expect(browserAgentCommand(ref)).toContain('--permission-mode auto')
    }
  })
})
