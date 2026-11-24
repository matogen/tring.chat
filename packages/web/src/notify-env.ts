/**
 * What a device can do about phone notifications, and what to call it: the
 * parts of notifications.ts that need no browser, so they can be tested.
 */

export interface Prefs {
  permission: boolean
  question: boolean
  reply: boolean
  onlyWhenAway: boolean
}

export const DEFAULT_PREFS: Prefs = { permission: true, question: true, reply: true, onlyWhenAway: true }

/** What this device can do, before asking anything of anyone. */
export type Support = 'ok' | 'insecure' | 'needs-install' | 'unsupported'

export interface Env {
  secure: boolean
  ios: boolean
  /** Opened from the Home Screen (or installed as an app). */
  standalone: boolean
  serviceWorker: boolean
  push: boolean
  notification: boolean
}

export function support(e: Env): Support {
  // Push needs a secure page: https, or this machine's own localhost.
  if (!e.secure) return 'insecure'
  // Safari only offers push to a site added to the Home Screen (iOS 16.4+),
  // and in plain Safari it does not even expose the API — so this comes first.
  if (e.ios && !e.standalone) return 'needs-install'
  if (!e.serviceWorker || !e.push || !e.notification) return 'unsupported'
  return 'ok'
}

/**
 * Whether this is a phone or tablet: notifications are offered only there.
 *
 * A phone or tablet's user agent, or iPadOS (which says Macintosh but has a
 * touch screen), or else a primary input that is touch with no hover. Not the
 * screen's width (a narrow desktop window is not a phone) and not "installed
 * as an app" (a desktop install is one too). A touch-screen laptop's primary
 * pointer is its trackpad, so it counts as a desktop.
 */
export function isPhone(e: { ua: string; maxTouchPoints: number; touchOnly: boolean }): boolean {
  if (/Android|iPhone|iPad|iPod/.test(e.ua)) return true
  if (/Macintosh/.test(e.ua) && e.maxTouchPoints > 1) return true
  return e.touchOnly
}

export function detectPhone(): boolean {
  return isPhone({
    ua: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    touchOnly: window.matchMedia('(hover: none) and (pointer: coarse)').matches,
  })
}

export function detectEnv(): Env {
  const ua = navigator.userAgent
  // iPadOS reports itself as a Mac; a Mac has no touch screen.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return {
    secure: window.isSecureContext,
    ios,
    standalone,
    serviceWorker: 'serviceWorker' in navigator,
    push: 'PushManager' in window,
    notification: 'Notification' in window,
  }
}

/** "iPhone · Safari": enough to tell devices apart, and nothing more. */
export function deviceLabel(ua: string): string {
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${os} · ${browser}`
}
