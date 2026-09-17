import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Images dropped on the terminal, landed on the daemon's disk.
 *
 * A browser hands a dropped file over as bytes and deliberately withholds its
 * path, so there is nothing to type into the prompt — and the path would be
 * the wrong machine's anyway whenever the deck is open somewhere other than
 * where the daemon runs. The bytes have to cross, be written down on this
 * side, and the path we chose is what gets typed.
 *
 * Bytes are only ever written here, never read back or served, and the name is
 * ours rather than the client's: nothing a caller sends reaches a filesystem
 * path. What it does add is attacker-controlled bytes on disk for whoever
 * holds the token — which is no new ground, since that same caller can already
 * ask this daemon for a shell.
 */

/** Big enough for any screenshot; small enough that a stray POST is cheap. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** How many drops to keep before the oldest are removed. */
const KEEP = 20

/**
 * Sniffed, never trusted from the request.
 *
 * A content-type header and a filename are both the caller's to choose, and
 * the extension is what tells Claude Code how to read the file — so the only
 * honest source is the first few bytes. These four are what it accepts.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (i: number, sig: readonly number[]): boolean =>
    sig.every((b, n) => bytes[i + n] === b)

  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return '.png'
  if (at(0, [0xff, 0xd8, 0xff])) return '.jpg'
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return '.gif'
  // RIFF....WEBP — the four size bytes in between are not part of the tell.
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return '.webp'
  return null
}

export class NotAnImage extends Error {
  constructor() {
    super('only PNG, JPEG, GIF and WebP images can be dropped on a terminal')
  }
}

export class UploadStore {
  constructor(private readonly dir: string, private readonly keep: number = KEEP) {}

  /** Writes the bytes and returns the absolute path to type into the prompt. */
  async save(bytes: Uint8Array): Promise<string> {
    const ext = sniffImage(bytes)
    if (!ext) throw new NotAnImage()

    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    // Ours, not the client's, and unguessable — a dropped name never touches
    // a path, so there is no traversal to get wrong.
    const file = path.join(this.dir, randomBytes(8).toString('hex') + ext)
    await writeFile(file, bytes, { mode: 0o600 })
    await this.prune()
    return file
  }

  /** Drops are scratch: a daemon that stops has nothing left to point at. */
  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true }).catch(() => {})
  }

  /**
   * Oldest first, newest kept. A deck left open for weeks would otherwise
   * accumulate every screenshot ever dropped into it.
   */
  private async prune(): Promise<void> {
    try {
      const names = await readdir(this.dir)
      if (names.length <= this.keep) return
      const dated = await Promise.all(names.map(async (name) => {
        const full = path.join(this.dir, name)
        return { full, at: (await stat(full)).mtimeMs }
      }))
      dated.sort((a, b) => b.at - a.at)
      await Promise.all(dated.slice(this.keep).map((f) => rm(f.full, { force: true })))
    } catch {
      // A prune that fails is not a drop that failed; the file is written.
    }
  }
}
