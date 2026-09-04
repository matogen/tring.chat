import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkForUpdate, currentVersion, isNewer } from '../src/update-check.ts'

describe('update check', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks the registry in a way it will actually answer', async () => {
    // Measured against registry.npmjs.org: the abbreviated-metadata type is
    // only valid on the packument, and /latest answers 406 to it. A 406 makes
    // res.ok false, so the check returns null and no update is ever announced
    // — silently, because a missing package looks the same.
    const seen: { url: string; accept: string | undefined }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const accept = (init.headers as Record<string, string> | undefined)?.['accept']
      seen.push({ url: String(url), accept })
      if (String(url).endsWith('/latest') && accept === 'application/vnd.npm.install-v1+json') {
        return new Response(null, { status: 406 })
      }
      return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 })
    })

    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-upd-'))
    const latest = await checkForUpdate(path.join(dir, 'update-check.json'))

    expect(seen.length, 'the registry was never asked').toBeGreaterThan(0)
    expect(latest, `registry refused the request: ${JSON.stringify(seen)}`).toBe('9.9.9')
  })

  it('compares versions by component, not by string order', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true)
    expect(isNewer('0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
    // The case a naive string compare gets wrong: "10" < "9" alphabetically.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.1.0', '0.2.0')).toBe(false)
  })

  it('ignores prereleases, since npm would not install them anyway', () => {
    expect(isNewer('0.2.0-beta.1', '0.1.0')).toBe(false)
  })

  it('reads its own version from the package', () => {
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('uses a fresh cache without touching the network', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-upd-'))
    const cache = path.join(dir, 'update-check.json')
    await writeFile(cache, JSON.stringify({ checkedAt: Date.now(), latest: '99.0.0' }))
    expect(await checkForUpdate(cache)).toBe('99.0.0')
  })

  it('reports nothing when the cached version is not newer', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-upd-'))
    const cache = path.join(dir, 'update-check.json')
    await writeFile(cache, JSON.stringify({ checkedAt: Date.now(), latest: '0.0.1' }))
    expect(await checkForUpdate(cache)).toBeNull()
  })
})
