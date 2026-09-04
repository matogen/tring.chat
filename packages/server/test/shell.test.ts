import { describe, it, expect } from 'vitest'
import { commandArgs, defaultShell, interactiveArgs } from '../src/shell.ts'

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
