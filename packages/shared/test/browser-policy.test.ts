import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ALLOW,
  checkNavigation,
  isLoopback,
  isPromptable,
  matchesPattern,
  type NavigationPolicy,
} from '../src/browser-policy.ts'

const policy = (over: Partial<NavigationPolicy> = {}): NavigationPolicy => ({
  allow: [...DEFAULT_ALLOW],
  daemonPort: 7331,
  daemonHost: null,
  ...over,
})

describe('matchesPattern', () => {
  it('matches an exact host on any port when the port is *', () => {
    expect(matchesPattern('localhost:*', 'localhost', 5173)).toBe(true)
  })

  it('matches a bare host on any port', () => {
    expect(matchesPattern('example.com', 'example.com', 443)).toBe(true)
  })

  it('honours an explicit port', () => {
    expect(matchesPattern('localhost:5173', 'localhost', 5173)).toBe(true)
    expect(matchesPattern('localhost:5173', 'localhost', 5174)).toBe(false)
  })

  it('a wildcard covers nested subdomains', () => {
    expect(matchesPattern('*.example.com', 'a.example.com', 443)).toBe(true)
    expect(matchesPattern('*.example.com', 'a.b.example.com', 443)).toBe(true)
  })

  it('a wildcard does not cover the apex — widening must be deliberate', () => {
    expect(matchesPattern('*.example.com', 'example.com', 443)).toBe(false)
  })

  it('does not let a wildcard escape the suffix', () => {
    expect(matchesPattern('*.example.com', 'example.com.evil.test', 443)).toBe(false)
    expect(matchesPattern('*.example.com', 'notexample.com', 443)).toBe(false)
  })

  it('treats dots literally', () => {
    expect(matchesPattern('a.example.com', 'aXexample.com', 443)).toBe(false)
  })

  it('does not mistake an IPv6 colon for a port separator', () => {
    // Without the bracket rule this parses as host ':' on port 1.
    expect(matchesPattern('::1', '::1', 7331)).toBe(true)
    expect(matchesPattern('[::1]', '[::1]', 7331)).toBe(true)
    expect(matchesPattern('[::1]:7331', '[::1]', 7331)).toBe(true)
    expect(matchesPattern('[::1]:7331', '[::1]', 5173)).toBe(false)
  })
})

describe('isLoopback', () => {
  it('knows the many spellings of the same machine', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '::1', '[::1]']) {
      expect(isLoopback(h), h).toBe(true)
    }
  })

  it('does not over-match', () => {
    for (const h of ['example.com', '128.0.0.1', '10.0.0.1', '127.example.com']) {
      expect(isLoopback(h), h).toBe(false)
    }
  })
})

describe('checkNavigation', () => {
  it('allows a host on the allowlist', () => {
    expect(checkNavigation('http://localhost:5173/app', policy())).toEqual({ ok: true })
  })

  it('holds a host that is not, and offers it to the user', () => {
    const v = checkNavigation('https://example.com/', policy())
    expect(v).toEqual({ ok: false, reason: 'not-allowed', host: 'example.com' })
    expect(isPromptable(v)).toBe(true)
  })

  it('refuses non-http schemes outright', () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'data:text/html,hi']) {
      const v = checkNavigation(url, policy())
      expect(v.ok, url).toBe(false)
      expect(isPromptable(v), url).toBe(false)
    }
  })

  it('refuses a malformed url rather than throwing', () => {
    expect(checkNavigation('not a url', policy())).toEqual({ ok: false, reason: 'malformed' })
  })

  /**
   * The rule a later refactor would see as redundant and fold away, because the
   * daemon is on loopback and loopback is on the default allowlist. Folding it
   * away hands an agent its own ring: the tring page takes a bearer token from
   * a query parameter and drives every terminal on the machine.
   */
  describe("the daemon's own origin", () => {
    it('is refused even though the allowlist admits 127.0.0.1 and localhost', () => {
      const p = policy()
      expect(matchesPattern('127.0.0.1:*', '127.0.0.1', 7331)).toBe(true)

      for (const url of [
        'http://127.0.0.1:7331/?token=secret',
        'http://localhost:7331/',
        'http://127.0.0.2:7331/api/sessions',
        'https://localhost:7331/',
      ]) {
        expect(checkNavigation(url, p), url).toEqual({ ok: false, reason: 'daemon' })
      }
    })

    it('is not promptable — the user cannot wave it through', () => {
      expect(isPromptable(checkNavigation('http://127.0.0.1:7331/', policy()))).toBe(false)
    })

    it('is refused when the allowlist explicitly names it', () => {
      const p = policy({ allow: ['127.0.0.1:7331', '*'] })
      expect(checkNavigation('http://127.0.0.1:7331/?token=x', p))
        .toEqual({ ok: false, reason: 'daemon' })
    })

    it('covers a non-loopback bind, where the host is the only clue', () => {
      const p = policy({ daemonHost: '100.64.0.1', allow: ['*'] })
      expect(checkNavigation('http://100.64.0.1:7331/', p))
        .toEqual({ ok: false, reason: 'daemon' })
    })

    it('does not refuse a different port on the same machine', () => {
      // The dev server is the whole point of the default allowlist.
      expect(checkNavigation('http://127.0.0.1:5173/', policy())).toEqual({ ok: true })
    })

    it('does not mistake the default http port for the daemon port', () => {
      const p = policy({ daemonPort: 80, allow: ['*'] })
      expect(checkNavigation('https://example.com/', p)).toEqual({ ok: true })
    })
  })
})
