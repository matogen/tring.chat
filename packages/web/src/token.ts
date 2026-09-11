/**
 * The daemon's bearer token, when it was started with --token.
 *
 * It arrives once, on the URL you were handed. An installed app starts from
 * the manifest's start_url, which cannot carry it, so the first visit puts it
 * in storage and every later start reads it back. A token on the URL always
 * wins, so a rotated secret only needs the link opened once more.
 */
const KEY = 'tring.token'

export interface TokenStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function resolveToken(search: string, store: TokenStore): string | undefined {
  const fromUrl = new URLSearchParams(search).get('token')
  if (fromUrl) {
    try { store.setItem(KEY, fromUrl) } catch { /* private window: this visit still works */ }
    return fromUrl
  }
  try { return store.getItem(KEY) ?? undefined } catch { return undefined }
}
