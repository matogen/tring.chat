import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  bearerEquals, createOriginCheck, secretEquals, SECURITY_HEADERS,
} from '../src/security.ts'

const req = (headers: Record<string, string>): IncomingMessage =>
  ({ headers } as unknown as IncomingMessage)

describe('origin check', () => {
  const allowed = createOriginCheck()

  it('refuses a socket opened by a page on another site', () => {
    // The whole point: the same-origin policy does not gate WebSockets, so
    // without this any site the user is reading can drive a shell here.
    expect(allowed(req({ host: '127.0.0.1:7331', origin: 'https://evil.example' }))).toBe(false)
  })

  it('accepts the page the daemon itself served', () => {
    expect(allowed(req({ host: '127.0.0.1:7331', origin: 'http://127.0.0.1:7331' }))).toBe(true)
    expect(allowed(req({ host: 'localhost:7331', origin: 'http://localhost:7331' }))).toBe(true)
  })

  it('accepts clients that send no Origin, which is what the hooks and curl are', () => {
    expect(allowed(req({ host: '127.0.0.1:7331' }))).toBe(true)
  })

  it('refuses an opaque origin, as a sandboxed frame or a file:// page sends', () => {
    expect(allowed(req({ host: '127.0.0.1:7331', origin: 'null' }))).toBe(false)
  })

  it('is not fooled by an origin that merely starts with the right host', () => {
    expect(allowed(req({ host: '127.0.0.1:7331', origin: 'http://127.0.0.1:7331.evil.example' })))
      .toBe(false)
    // A different port is a different origin, and a different program.
    expect(allowed(req({ host: '127.0.0.1:7331', origin: 'http://127.0.0.1:9999' }))).toBe(false)
  })

  it('refuses a rebound domain pointed at loopback, which would match Host', () => {
    // DNS rebinding gives the attacker a Host *and* an Origin they control and
    // that agree with each other. Bound to loopback, only loopback names can
    // legitimately reach us, so the name itself is the tell.
    expect(allowed(req({ host: 'evil.example:7331', origin: 'http://evil.example:7331' })))
      .toBe(false)
    expect(allowed(req({ host: 'evil.example:7331' }))).toBe(false)
  })

  it('lets the dev server through when it is named, and nothing else', () => {
    const dev = createOriginCheck({ allow: ['http://localhost:5173'] })
    expect(dev(req({ host: '127.0.0.1:7331', origin: 'http://localhost:5173' }))).toBe(true)
    expect(dev(req({ host: '127.0.0.1:7331', origin: 'http://localhost:5174' }))).toBe(false)
  })

  it('stops pinning Host once the daemon is deliberately bound off loopback', () => {
    // Then the hostname is the user's own — Tailscale, a LAN name — and we
    // cannot guess it, so the Origin must still match but the name is free.
    const lan = createOriginCheck({ host: '0.0.0.0' })
    expect(lan(req({ host: 'box.tail1234.ts.net:7331', origin: 'http://box.tail1234.ts.net:7331' })))
      .toBe(true)
    expect(lan(req({ host: 'box.tail1234.ts.net:7331', origin: 'https://evil.example' })))
      .toBe(false)
  })
})

describe('constant-time comparison', () => {
  it('accepts only the exact secret', () => {
    expect(secretEquals('s3cret', 's3cret')).toBe(true)
    expect(secretEquals('s3cret', 's3crew')).toBe(false)
    expect(secretEquals('s3cret', 's3cret ')).toBe(false)
    expect(secretEquals('s3cret', '')).toBe(false)
  })

  it('never lets a missing token count as a match', () => {
    expect(secretEquals('s3cret', undefined)).toBe(false)
    expect(secretEquals('s3cret', null)).toBe(false)
    expect(secretEquals(null, null)).toBe(false)
  })

  it('reads the bearer scheme case-insensitively but the secret exactly', () => {
    expect(bearerEquals('s3cret', 'Bearer s3cret')).toBe(true)
    expect(bearerEquals('s3cret', 'bearer s3cret')).toBe(true)
    expect(bearerEquals('s3cret', 'Bearer S3CRET')).toBe(false)
    expect(bearerEquals('s3cret', 's3cret')).toBe(false)
    expect(bearerEquals('s3cret', undefined)).toBe(false)
  })
})

describe('security headers', () => {
  it('refuses framing and pins the CSP to same-origin', () => {
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY')
    expect(SECURITY_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(SECURITY_HEADERS['content-security-policy']).toContain("default-src 'self'")
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff')
  })
})
