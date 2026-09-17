import { describe, it, expect } from 'vitest'
import { commandArgs, defaultShell, interactiveArgs, envRef } from '../src/shell.ts'

describe('shell resolution', () => {
  it('passes commands the way each shell expects', () => {
    expect(commandArgs('/bin/bash', 'echo hi')).toEqual(['-c', 'echo hi'])
    expect(commandArgs('/usr/bin/zsh', 'echo hi')).toEqual(['-c', 'echo hi'])
    expect(commandArgs('powershell.exe', 'echo hi')).toEqual(['-NoLogo', '-Command', 'echo hi'])
    expect(commandArgs('pwsh', 'echo hi')).toEqual(['-NoLogo', '-Command', 'echo hi'])
    expect(commandArgs('C:\\Windows\\System32\\cmd.exe', 'echo hi')).toEqual(['/c', 'echo hi'])
  })

  it('drives a WSL shell from a Windows-native daemon', () => {
    expect(commandArgs('wsl.exe', 'echo hi')).toEqual(['-e', 'bash', '-lc', 'echo hi'])
  })

  it('matches on the basename, so a full path works and case does not matter', () => {
    expect(commandArgs('C:\\Program Files\\PowerShell\\7\\PWSH.EXE', 'x'))
      .toEqual(['-NoLogo', '-Command', 'x'])
  })

  it('starts PowerShell without its banner, and other shells bare', () => {
    expect(interactiveArgs('powershell.exe')).toEqual(['-NoLogo'])
    expect(interactiveArgs('/bin/bash')).toEqual([])
  })

  it('honours TRING_SHELL over the platform default', () => {
    const prev = process.env['TRING_SHELL']
    process.env['TRING_SHELL'] = '/usr/bin/fish'
    try {
      expect(defaultShell()).toBe('/usr/bin/fish')
    } finally {
      if (prev === undefined) delete process.env['TRING_SHELL']
      else process.env['TRING_SHELL'] = prev
    }
  })

  it('falls back to $SHELL on this platform rather than a hardcoded path', () => {
    expect(defaultShell()).toBe(process.env['SHELL'] ?? '/bin/bash')
  })
})

/**
 * The Browser Agent default command references $TRING_MCP_CONFIG, and the two
 * shells this project ships as Windows defaults do not understand `$VAR`. The
 * failure is silent — the wrong spelling expands to an empty string, so the
 * agent starts with no tools and nothing says why — which is exactly the shape
 * of bug that reaches a user instead of a test.
 */
describe('envRef', () => {
  it('uses POSIX form for bash and friends', () => {
    expect(envRef('/bin/bash', 'TRING_MCP_CONFIG')).toBe('"$TRING_MCP_CONFIG"')
    expect(envRef('/usr/bin/zsh', 'TRING_MCP_CONFIG')).toBe('"$TRING_MCP_CONFIG"')
  })

  it('uses $env: for PowerShell, which is the Windows default', () => {
    expect(envRef('powershell.exe', 'TRING_MCP_CONFIG')).toBe('$env:TRING_MCP_CONFIG')
    expect(envRef('pwsh.exe', 'TRING_MCP_CONFIG')).toBe('$env:TRING_MCP_CONFIG')
  })

  it('uses %VAR% for cmd', () => {
    expect(envRef('cmd.exe', 'TRING_MCP_CONFIG')).toBe('%TRING_MCP_CONFIG%')
  })

  /** `--shell wsl.exe` runs bash, so it is POSIX despite the .exe. */
  it('treats wsl.exe as POSIX, because it is bash underneath', () => {
    expect(envRef('wsl.exe', 'TRING_MCP_CONFIG')).toBe('"$TRING_MCP_CONFIG"')
  })

  it('reads a shell name the same way whatever the host separator', () => {
    expect(envRef('C:\\Windows\\System32\\cmd.exe', 'X')).toBe('%X%')
  })
})
