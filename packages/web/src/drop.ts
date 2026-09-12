import { DAEMON, TOKEN } from './ws-client.ts'

/**
 * Files dropped onto the deck.
 *
 * The page has to claim the drop itself: a browser's default action for an
 * unclaimed one is to navigate to the file, and in a chromeless `--app` window
 * that navigation leaves as a whole separate browser window — the deck is gone
 * and the file is open in a tab nobody asked for. So every drop is swallowed,
 * wherever it lands.
 *
 * Where the file *is* cannot be read here — Chrome withholds local paths from
 * page content, and a Windows browser driving a WSL daemon would be naming the
 * wrong machine anyway — so the bytes go to the daemon and come back as a path
 * the agent on the other end of the PTY can open.
 */

interface DropHost {
  /** Whether there is a PTY to paste into at all. */
  focused: () => boolean
  paste: (text: string) => void
  notify: (message: string) => void
}

async function upload(file: File): Promise<string> {
  const res = await fetch(`${DAEMON}/api/drop?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    body: file,
  })
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string }
  if (!res.ok || !body.path) throw new Error(body.error ?? `upload failed (${res.status})`)
  return body.path
}

/** A path is one argument even when it holds spaces. */
export const quote = (p: string): string =>
  /[^\w./-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p

export function installDropTarget(host: DropHost): void {
  const over = (e: DragEvent): void => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    document.body.classList.add('dropping')
  }
  // dragleave also fires crossing between children, so the end of a drag is
  // read off the pointer leaving the window rather than off any one element.
  const leave = (e: DragEvent): void => {
    if (!e.relatedTarget) document.body.classList.remove('dropping')
  }

  window.addEventListener('dragover', over)
  window.addEventListener('dragleave', leave)
  window.addEventListener('dragend', () => document.body.classList.remove('dropping'))

  window.addEventListener('drop', (e) => {
    e.preventDefault()
    document.body.classList.remove('dropping')
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    if (!host.focused()) return host.notify('focus a session before dropping files')

    host.notify(`uploading ${files.length === 1 ? files[0]!.name : `${files.length} files`}…`)
    void Promise.all(files.map(upload))
      .then((paths) => {
        // No newline: the path is dropped into whatever you were typing, and
        // pressing Enter stays your decision.
        host.paste(paths.map(quote).join(' ') + ' ')
        host.notify(`dropped ${paths.length === 1 ? paths[0]! : `${paths.length} files`}`)
      })
      .catch((err: Error) => host.notify(err.message))
  })
}
