/**
 * Dropping images on the terminal (spec §5.4).
 *
 * A terminal you drag a file onto is expected to type its path for you. This
 * one is a web page, so there is no path to type: the browser hands over the
 * bytes and withholds the location by design. They go to the daemon, which
 * writes them down on the machine the shell is actually running on and says
 * where — and that is what gets typed.
 */

/** Images Claude Code can read; anything else in the drop is left alone. */
export const IMAGE = /^image\/(png|jpeg|gif|webp)$/

export interface DropOptions {
  /** Sends one file and resolves with its path on the daemon's machine. */
  upload: (file: Blob) => Promise<string>
  /** Puts the finished text into the terminal, as a paste. */
  insert: (text: string) => void
  /** False while there is no terminal to drop on — no session is focused. */
  ready: () => boolean
  onError: (message: string) => void
}

/**
 * A path as the prompt should receive it.
 *
 * Bare, because Claude Code reads a path and not a shell word — quoted only
 * when the path carries whitespace, which ours can when the home directory
 * does. Double quotes rather than backslashes: a shell takes both, and Claude
 * Code does not read escapes.
 */
export function pathForPrompt(file: string): string {
  return /\s/.test(file) ? `"${file}"` : file
}

/**
 * The browser's own handling of a dropped file is to navigate to it, which
 * throws away the whole deck — every tile, and the socket holding them. That
 * has to be refused everywhere, not only over the terminal.
 */
export function refuseStrayDrops(target: WindowEventHandlers & EventTarget): void {
  for (const type of ['dragover', 'drop']) {
    target.addEventListener(type, (e) => e.preventDefault())
  }
}

export function attachImageDrop(el: HTMLElement, opts: DropOptions): void {
  // dragenter and dragleave both fire again for every child element the
  // pointer crosses, so the highlight is counted in rather than toggled.
  let depth = 0
  const paint = (on: boolean): void => { el.classList.toggle('dropping', on) }

  const carriesFiles = (e: DragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files')

  el.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    depth++
    paint(true)
  })

  el.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    // Without this the pointer says "move", and some file managers take that
    // literally on drop.
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  })

  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) paint(false)
  })

  el.addEventListener('drop', (e) => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    depth = 0
    paint(false)
    void receive(Array.from(e.dataTransfer?.files ?? []), opts)
  })
}

async function receive(files: File[], opts: DropOptions): Promise<void> {
  const images = files.filter((f) => IMAGE.test(f.type))
  if (images.length === 0) {
    opts.onError(files.length > 0
      ? 'only PNG, JPEG, GIF and WebP images can be dropped on a terminal'
      : 'nothing to drop')
    return
  }
  await insertImages(images, opts)
}

/**
 * Uploads each image and types the paths, however they arrived — dropped,
 * pasted with Ctrl+V, or read off a phone's clipboard (see paste.ts).
 */
export async function insertImages(images: Blob[], opts: DropOptions): Promise<void> {
  if (!opts.ready()) {
    opts.onError('focus a session first — the image goes into its prompt')
    return
  }

  const paths: string[] = []
  for (const file of images) {
    try {
      paths.push(pathForPrompt(await opts.upload(file)))
    } catch (err) {
      opts.onError((err as Error).message)
      // The ones that did arrive are still worth typing.
      break
    }
  }
  // One paste with a trailing space, so the next thing typed is a sentence
  // about the image rather than part of its name.
  if (paths.length > 0) opts.insert(paths.join(' ') + ' ')
}
