/**
 * Pasting into the terminal (spec §5.4, §5.11).
 *
 * Text already arrives through xterm: Ctrl+V lands on the textarea it listens
 * on, and xterm wraps the text for an app that asked for bracketed paste. Two
 * things never arrive that way.
 *
 * An image on the clipboard — a screenshot copied rather than saved — is a
 * file, and xterm reads only the text of a paste, so Ctrl+V with a screenshot
 * did nothing. Here a capture-phase handler ahead of xterm's takes the images
 * the way a drop does: up to the daemon, and the path into the prompt.
 *
 * On a phone there is no Ctrl+V, and the textarea xterm listens on is a
 * transparent sliver at the cursor that no finger can find to long-press. So
 * the switcher bar carries a paste button that asks the clipboard directly.
 * iOS answers with its own "Paste" bubble to tap; Android asks once for
 * permission. When the browser will not hand the clipboard over at all — an
 * http origin, a refused permission, an API that is not there — a sheet with
 * a real textarea opens instead, which every phone knows how to paste into.
 */

import { IMAGE, insertImages, type DropOptions } from './drop.ts'

export type PasteOptions = DropOptions

/** The image files in a paste, if the clipboard carried any. */
export function imagesIn(files: ArrayLike<File> | null | undefined): File[] {
  return Array.from(files ?? []).filter((f) => IMAGE.test(f.type))
}

export function attachImagePaste(el: HTMLElement, opts: PasteOptions): void {
  el.addEventListener(
    'paste',
    (e) => {
      const images = imagesIn(e.clipboardData?.files)
      // Text is xterm's: its own handler on the textarea does the wrapping.
      if (images.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      void insertImages(images, opts)
    },
    { capture: true },
  )
}

/** The shape of `ClipboardItem` this reads, so a test can hand in a fake. */
export interface ClipboardEntry {
  readonly types: readonly string[]
  getType(type: string): Promise<Blob>
}

export interface ClipboardContents {
  images: Blob[]
  text: string
}

/**
 * What the clipboard holds, sorted into what the terminal can take. An item
 * that is both — an image copied from a web page comes with its HTML — counts
 * as the image: that is what was copied.
 */
export async function sortClipboard(items: readonly ClipboardEntry[]): Promise<ClipboardContents> {
  const images: Blob[] = []
  let text = ''
  for (const item of items) {
    const image = item.types.find((t) => IMAGE.test(t))
    if (image) {
      images.push(await item.getType(image))
    } else if (item.types.includes('text/plain')) {
      text += await (await item.getType('text/plain')).text()
    }
  }
  return { images, text }
}

export interface ClipboardPasteOptions extends PasteOptions {
  /** Opens the sheet to paste into when the clipboard cannot be read. */
  fallback: () => void
}

/**
 * The paste button. `navigator.clipboard.read()` hands over text and images
 * alike, and must run inside the tap that asked for it: the permission bubble
 * only appears from a user gesture.
 */
export async function pasteFromClipboard(opts: ClipboardPasteOptions): Promise<void> {
  if (!opts.ready()) {
    opts.onError('focus a session first — the paste goes into its prompt')
    return
  }
  let items: ClipboardItem[]
  try {
    items = await navigator.clipboard.read()
  } catch {
    // Refused, unsupported, or an insecure origin where `clipboard` is
    // undefined altogether. All the same to the user: paste by hand instead.
    opts.fallback()
    return
  }
  const { images, text } = await sortClipboard(items)
  if (images.length > 0) await insertImages(images, opts)
  else if (text) opts.insert(text)
  else opts.onError('nothing on the clipboard to paste')
}
