import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseArgs, UsageError } from '../src/args.ts'

/**
 * parseArgs reads TRING_* at call time, and the machine running the tests may
 * well have some set — a stray TRING_TOKEN would quietly satisfy assertions
 * about the defaults.
 */
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('TRING_')) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  }
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
})

const SECRET = 'a'.repeat(64)

describe('flags that take a value', () => {
  it('refuses a trailing flag rather than coercing the missing value', () => {
    // `String(argv[++i])` used to make this the nine-character string
    // "undefined" — truthy, so it satisfied every `if (token)` gate and the
    // daemon bound 0.0.0.0 behind a secret an attacker guesses first.
    expect(() => parseArgs(['--host', '0.0.0.0', '--token'])).toThrow(UsageError)
    expect(() => parseArgs(['--host', '0.0.0.0', '--token'])).toThrow(/--token needs a value/)
    expect(() => parseArgs(['--host'])).toThrow(/--host needs a value/)
    expect(() => parseArgs(['--port'])).toThrow(/--port needs a value/)
    expect(() => parseArgs(['--shell'])).toThrow(/--shell needs a value/)
  })

  it('refuses to swallow the next flag as a value', () => {
    // This one used to be quieter and worse: token "--host", and the bind
    // address silently dropped, so the operator believed they were on 0.0.0.0
    // behind a real secret while actually on loopback behind "--host".
    expect(() => parseArgs(['--token', '--host', '0.0.0.0'])).toThrow(/next argument is --host/)
  })

  it('still allows a dashed value when the = says it was meant', () => {
    expect(parseArgs([`--token=${SECRET}`]).token).toBe(SECRET)
    expect(parseArgs(['--shell=--weird']).shell).toBe('--weird')
  })

  it('refuses an empty value', () => {
    expect(() => parseArgs(['--token='])).toThrow(/--token needs a value/)
    expect(() => parseArgs(['--host', ''])).toThrow(/--host needs a value/)
  })

  it('refuses a value on a flag that takes none', () => {
    expect(() => parseArgs(['--no-open=1'])).toThrow(/--no-open takes no value/)
  })

  it('does not consume the next argument for a boolean flag', () => {
    const args = parseArgs(['--no-open', '--port', '9000'])
    expect(args.open).toBe(false)
    expect(args.port).toBe(9000)
  })

  it('refuses a flag it does not know instead of ignoring it', () => {
    // A silently-ignored `--tokn` is an unauthenticated daemon that reads as
    // an authenticated one.
    expect(() => parseArgs([`--tokn=${SECRET}`])).toThrow(/unknown argument/)
    expect(() => parseArgs(['stray'])).toThrow(/unknown argument stray/)
  })
})

describe('numeric flags', () => {
  it('refuses values that are not numbers', () => {
    expect(() => parseArgs(['--port=eight'])).toThrow(/--port needs a number/)
    expect(() => parseArgs(['--scrollback=lots'])).toThrow(/--scrollback needs a number/)
  })

  it('refuses ports the OS cannot bind, rather than listen(null)', () => {
    expect(() => parseArgs(['--port=70000'])).toThrow(/0 to 65535/)
    expect(() => parseArgs(['--port=-1'])).toThrow(/0 to 65535/)
    expect(() => parseArgs(['--port=80.5'])).toThrow(/0 to 65535/)
    expect(parseArgs(['--port=7332']).port).toBe(7332)
  })

  it('refuses a negative scrollback or idle window', () => {
    expect(() => parseArgs(['--scrollback=-1'])).toThrow(/whole number of lines/)
    expect(() => parseArgs(['--idle-ms=-5'])).toThrow(/whole number of milliseconds/)
  })
})

describe('token strength', () => {
  it('refuses a secret short enough to be an accident', () => {
    expect(() => parseArgs(['--token=undefined'])).toThrow(/at least 16 characters/)
    expect(() => parseArgs(['--token=hunter2'])).toThrow(/at least 16 characters/)
  })

  it('applies the same rule to the environment variable', () => {
    process.env['TRING_TOKEN'] = 'undefined'
    expect(() => parseArgs([])).toThrow(/TRING_TOKEN/)
    process.env['TRING_TOKEN'] = SECRET
    expect(parseArgs([]).token).toBe(SECRET)
  })

  it('accepts what the documented openssl line produces', () => {
    expect(parseArgs(['--token', SECRET]).token).toBe(SECRET)
  })
})

describe('tls', () => {
  it('requires the certificate and the key together', () => {
    expect(() => parseArgs(['--tls-cert=/tmp/c.pem'])).toThrow(/must be given together/)
    expect(() => parseArgs(['--tls-key=/tmp/k.pem'])).toThrow(/must be given together/)
    const args = parseArgs(['--tls-cert=/tmp/c.pem', '--tls-key=/tmp/k.pem'])
    expect(args.tlsCert).toBe('/tmp/c.pem')
    expect(args.tlsKey).toBe('/tmp/k.pem')
  })

  it('defaults to no tls at all', () => {
    expect(parseArgs([]).tlsCert).toBeNull()
  })
})

describe('defaults', () => {
  it('starts on loopback with no explicit token, which is then generated', () => {
    const args = parseArgs([])
    expect(args.host).toBe('127.0.0.1')
    expect(args.token).toBeNull()
    expect(args.insecureNoToken).toBe(false)
  })

  it('collects repeatable list flags from both forms', () => {
    const args = parseArgs([
      '--fs-root', '/a', '--fs-root=/b,/c', '--allow-origin', 'http://localhost:5173',
    ])
    expect(args.fsRoot).toEqual(['/a', '/b', '/c'])
    expect(args.allowOrigin).toEqual(['http://localhost:5173'])
  })
})
