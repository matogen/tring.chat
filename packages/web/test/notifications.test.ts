import { describe, expect, it } from 'vitest'
import { deviceLabel, isPhone, support, type Env } from '../src/notify-env.ts'

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

describe('isPhone', () => {
  const ua = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
    ipados: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  }
  it('says yes for phones and tablets, including an iPad calling itself a Mac', () => {
    expect(isPhone({ ua: ua.iphone, maxTouchPoints: 5, touchOnly: true })).toBe(true)
    expect(isPhone({ ua: ua.android, maxTouchPoints: 5, touchOnly: true })).toBe(true)
    expect(isPhone({ ua: ua.ipados, maxTouchPoints: 5, touchOnly: true })).toBe(true)
  })
  it('says no for a desktop, a Mac, or a touch-screen laptop driven by its trackpad', () => {
    expect(isPhone({ ua: ua.windows, maxTouchPoints: 0, touchOnly: false })).toBe(false)
    expect(isPhone({ ua: ua.ipados, maxTouchPoints: 0, touchOnly: false })).toBe(false)
    expect(isPhone({ ua: ua.windows, maxTouchPoints: 10, touchOnly: false })).toBe(false)
  })
  it('trusts a touch-only device with an unknown user agent', () => {
    expect(isPhone({ ua: 'SomeTablet/1.0', maxTouchPoints: 5, touchOnly: true })).toBe(true)
  })
})
