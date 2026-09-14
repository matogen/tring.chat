/**
 * The daemon's bearer token, when it was started with --token.
 *
 * It arrives once, on the URL you were handed. An installed app starts from
 * the manifest's start_url, which cannot carry it, so the first visit puts it
 * in storage and every later start reads it back. A token on the URL always
 * wins, so a rotated secret only needs the link opened once more.
 *
 * Once it is in storage the URL has no further use for it, and a secret in a
 * URL is only as private as the URL: it lands in history, in anything that
 * logs a request line, and in the Referer of every link followed from the
 * page. So `scrub` is called to take it back off the address bar — which is
 * also why rotating a token does not retire the old link.
 */
const KEY = 'tring.token'

export interface TokenStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function resolveToken(
  search: string,
  store: TokenStore,
  scrub?: () => void,
): string | undefined {
  const fromUrl = new URLSearchParams(search).get('token')
  if (fromUrl) {
    try { store.setItem(KEY, fromUrl) } catch { /* private window: this visit still works */ }
    try { scrub?.() } catch { /* no history API: the token still works */ }
    return fromUrl
  }
  try { return store.getItem(KEY) ?? undefined } catch { return undefined }
}
