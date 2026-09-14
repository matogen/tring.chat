import { describe, expect, it } from 'vitest'
import { resolveToken } from '../src/token.ts'

const storage = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    dump: () => Object.fromEntries(m),
  }
}

describe('resolveToken', () => {
  it('takes the token from the URL and remembers it, so an installed app can start without it', () => {
    const st = storage()
    expect(resolveToken('?token=s3cret', st)).toBe('s3cret')
    expect(st.dump()).toEqual({ 'tring.token': 's3cret' })
  })

  it('falls back to the remembered token when the URL carries none', () => {
    expect(resolveToken('', storage({ 'tring.token': 'kept' }))).toBe('kept')
  })

  it('is undefined on a daemon that never needed one', () => {
    expect(resolveToken('', storage())).toBeUndefined()
  })

  it('lets a new URL token replace a stale remembered one', () => {
    const st = storage({ 'tring.token': 'old' })
    expect(resolveToken('?token=new', st)).toBe('new')
    expect(st.dump()['tring.token']).toBe('new')
  })

  it('takes the token back off the address bar once it is remembered', () => {
    // A secret in a URL lives on in history and in every Referer sent from
    // the page, long after storage has made the URL copy redundant.
    let scrubbed = false
    expect(resolveToken('?token=s3cret', storage(), () => { scrubbed = true })).toBe('s3cret')
    expect(scrubbed).toBe(true)
  })

  it('does not touch the URL when the token came from storage', () => {
    let scrubbed = false
    resolveToken('', storage({ 'tring.token': 'kept' }), () => { scrubbed = true })
    expect(scrubbed).toBe(false)
  })

  it('survives storage that throws, as private windows do', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(resolveToken('?token=t', broken)).toBe('t')
    expect(resolveToken('', broken)).toBeUndefined()
  })
})
