import { describe, expect, it } from 'vitest'
import { deviceLabel, support, type Env } from '../src/notify-env.ts'

const env = (over: Partial<Env> = {}): Env => ({
  secure: true, ios: false, standalone: false, serviceWorker: true, push: true, notification: true, ...over,
})

describe('support', () => {
  it('needs a secure page', () => {
    expect(support(env({ secure: false }))).toBe('insecure')
  })
  it('sends an iPhone in Safari to the Home Screen first, even though Safari hides the API there', () => {
    expect(support(env({ ios: true, push: false, notification: false }))).toBe('needs-install')
    expect(support(env({ ios: true, standalone: true }))).toBe('ok')
  })
  it('says when the browser cannot do push at all', () => {
    expect(support(env({ push: false }))).toBe('unsupported')
  })
  it('works in a desktop or Android browser tab', () => {
    expect(support(env())).toBe('ok')
  })
})

describe('deviceLabel', () => {
  it('tells devices apart without saying more', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'))
      .toBe('iPhone · Safari')
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36'))
      .toBe('Android · Chrome')
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0'))
      .toBe('Windows · Edge')
  })
})
