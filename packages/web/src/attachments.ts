/**
 * Files added to a card's reply box: pasted, dropped or picked, shown as chips
 * until the reply goes, then sent with it.
 *
 * They travel the way a file dropped on a terminal does (drop.ts): up to the
 * daemon, which writes each one down on the machine the agent runs on, and
 * the path goes into the prompt. Claude Code reads an image or a file from a
 * path in the prompt, so the agent gets what was attached.
 */
import { IMAGE, pathForPrompt } from './drop.ts'

export interface Attachment {
  id: number
  file: Blob
  /** What the chip says: the file's own name, or one made up for a pasted screenshot. */
  name: string
  /** An image Claude Code can look at, which gets a thumbnail. */
  image: boolean
}

/** The files waiting to go with one reply. */
export class PendingFiles {
  private items: Attachment[] = []
  private next = 1

  constructor(private readonly onChange: () => void = () => {}) {}

  get list(): readonly Attachment[] {
    return this.items
  }

  add(files: Iterable<Blob>): Attachment[] {
    const added: Attachment[] = []
    for (const file of files) {
      const id = this.next++
      added.push({ id, file, name: nameOf(file, id), image: IMAGE.test(file.type) })
    }
    if (added.length === 0) return added
    this.items = [...this.items, ...added]
    this.onChange()
    return added
  }

  remove(id: number): void {
    const left = this.items.filter((a) => a.id !== id)
    if (left.length === this.items.length) return
    this.items = left
    this.onChange()
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    this.onChange()
  }
}

/** A pasted screenshot is a bare Blob with no name, or one called "image.png" by the browser. */
export function nameOf(file: Blob, n: number): string {
  const own = typeof (file as File).name === 'string' ? (file as File).name : ''
  if (own && own !== 'image.png') return own
  const ext = /^image\/(\w+)/.exec(file.type)?.[1]?.replace('jpeg', 'jpg')
  return ext ? `pasted image ${n}.${ext}` : `pasted file ${n}`
}

/**
 * The files a paste into the reply box brings, if it is a paste of files.
 * Copying from Word or a spreadsheet puts a picture of the text on the
 * clipboard beside the text itself; that paste is the text, and the box
 * takes it as usual. Anything else with files in it — a screenshot, an image
 * copied from a page — is those files.
 */
export function pastedFiles(clipboard: { types: readonly string[]; files: ArrayLike<File> } | null | undefined): File[] {
  if (!clipboard || clipboard.types.includes('text/plain')) return []
  return Array.from(clipboard.files)
}

/**
 * The reply as the agent gets it: the paths first and then the words, the
 * order a terminal drop leaves them in, so the sentence reads as being about
 * the files.
 */
export function replyText(text: string, paths: readonly string[]): string {
  const files = paths.map(pathForPrompt).join(' ')
  const words = text.trim()
  return [files, words].filter(Boolean).join(' ')
}

/**
 * Uploads every file, in order, and resolves with their paths. All or none:
 * a reply that quietly left out a screenshot would be answered as if the
 * screenshot said nothing, so the first failure rejects and nothing is sent.
 */
export async function uploadAll(files: readonly Attachment[], upload: (file: Blob) => Promise<string>): Promise<string[]> {
  const paths: string[] = []
  for (const a of files) {
    try {
      paths.push(await upload(a.file))
    } catch (err) {
      throw new Error(`${a.name}: ${(err as Error).message}`)
    }
  }
  return paths
}

/** "12 KB", "3.4 MB": for the chip's tooltip. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
