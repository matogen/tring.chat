import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  defaultTokenPath, generateToken, loadOrCreateToken, MIN_TOKEN_LENGTH, tokenProblem,
} from '../src/token.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'tring-token-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const file = (): string => path.join(dir, 'nested', 'token')

describe('generated token', () => {
  it('is 32 bytes of hex, the shape openssl rand -hex 32 gives', () => {
    const token = generateToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenProblem(token)).toBeNull()
  })

  it('is different every time', () => {
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('token validation', () => {
  it('rejects the string a missing --token value used to produce', () => {
    expect(tokenProblem('undefined')).toMatch(/at least 16/)
  })

  it('rejects anything too short to be a secret', () => {
    expect(tokenProblem('')).not.toBeNull()
    expect(tokenProblem('a'.repeat(MIN_TOKEN_LENGTH - 1))).not.toBeNull()
    expect(tokenProblem('a'.repeat(MIN_TOKEN_LENGTH))).toBeNull()
  })

  it('rejects surrounding whitespace, which never survives a shell round trip', () => {
    expect(tokenProblem(` ${'a'.repeat(64)}`)).toMatch(/whitespace/)
    expect(tokenProblem(`${'a'.repeat(64)}\n`)).toMatch(/whitespace/)
  })
})

describe('persisted token', () => {
  it('creates one on first run, including the directory', () => {
    const token = loadOrCreateToken(file())
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(file(), 'utf8').trim()).toBe(token)
  })

  it('is stable across restarts, so installed PWAs and hooks keep working', () => {
    const first = loadOrCreateToken(file())
    expect(loadOrCreateToken(file())).toBe(first)
  })

  it('is owner-only on disk — the file is the credential', () => {
    loadOrCreateToken(file())
    // No mode bits to check on Windows, where the ACL does this job instead.
    if (process.platform === 'win32') return
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it('replaces a file too weak to be honoured rather than trusting it', () => {
    const f = path.join(dir, 'token')
    writeFileSync(f, 'short\n')
    const token = loadOrCreateToken(f)
    expect(token).not.toBe('short')
    expect(tokenProblem(token)).toBeNull()
  })

  it('tolerates a file written without the trailing newline', () => {
    const f = path.join(dir, 'token')
    const secret = 'b'.repeat(64)
    writeFileSync(f, secret)
    expect(loadOrCreateToken(f)).toBe(secret)
  })

  it('throws rather than falling back to no authentication', () => {
    // A path whose parent is a regular file cannot be created, which stands in
    // for the read-only home the daemon must refuse to start under.
    const blocked = path.join(dir, 'token')
    writeFileSync(blocked, 'x')
    expect(() => loadOrCreateToken(path.join(blocked, 'token'))).toThrow()
  })

  it('sits beside projects.json under the same config base', () => {
    const before = process.env['XDG_CONFIG_HOME']
    process.env['XDG_CONFIG_HOME'] = '/xdg'
    try {
      expect(defaultTokenPath()).toBe(path.join('/xdg', 'tring', 'token'))
    } finally {
      if (before === undefined) delete process.env['XDG_CONFIG_HOME']
      else process.env['XDG_CONFIG_HOME'] = before
    }
  })
})
