/**
 * Dragging a tile onto another slot: into an empty one it moves, onto an
 * occupied one the two swap. The daemon does the rearranging; this only says
 * which session went where.
 *
 * Pointer events, not HTML5 drag and drop. Every tile cancels its mousedown so
 * the keyboard stays on the terminal (see renderRing), and a cancelled
 * mousedown never starts a native drag. It also keeps tile drags well away
 * from file drops, which the whole window refuses by default (see drop.ts).
 */

/** How far the pointer travels before a press on a tile becomes a drag. */
const THRESHOLD = 6

export interface TileDragOptions {
  /** The session sitting in a slot, or undefined for an empty one. */
  sessionAt: (slot: number) => string | undefined
  onMove: (id: string, slot: number) => void
}

interface Drag {
  id: string
  from: HTMLElement
  pointer: number
  x: number
  y: number
  active: boolean
}

export function attachTileDrag(ring: HTMLElement, opts: TileDragOptions): void {
  let drag: Drag | null = null
  let over: HTMLElement | null = null

  const slotOf = (el: HTMLElement): number => Number(el.dataset['slot'])

  const tileAt = (x: number, y: number): HTMLElement | null => {
    const tile = document.elementFromPoint(x, y)?.closest<HTMLElement>('.tile[data-slot]') ?? null
    return tile && ring.contains(tile) ? tile : null
  }

  const setOver = (el: HTMLElement | null): void => {
    if (el === over) return
    over?.classList.remove('drop-target')
    over = el
    over?.classList.add('drop-target')
  }

  const end = (): void => {
    drag?.from.classList.remove('dragging')
    document.body.classList.remove('tile-dragging')
    setOver(null)
    drag = null
  }

  /**
   * The click that ends a drag would otherwise land on a tile — focusing the
   * dragged session, or asking to create one in the empty slot it was dropped
   * on. Swallowed once, in the capture phase, before any tile sees it.
   */
  const swallowNextClick = (): void => {
    const stop = (e: Event): void => {
      e.stopPropagation()
      e.preventDefault()
    }
    window.addEventListener('click', stop, { capture: true, once: true })
    // A drop outside the window never produces a click; do not eat a later one.
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0)
  }

  ring.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return
    if (e.target.closest('.tile-action')) return
    const tile = e.target.closest<HTMLElement>('.tile[data-slot]')
    if (!tile) return
    const id = opts.sessionAt(slotOf(tile))
    if (!id) return
    drag = { id, from: tile, pointer: e.pointerId, x: e.clientX, y: e.clientY, active: false }
  })

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < THRESHOLD) return
      drag.active = true
      drag.from.classList.add('dragging')
      document.body.classList.add('tile-dragging')
    }
    const tile = tileAt(e.clientX, e.clientY)
    setOver(tile && tile !== drag.from ? tile : null)
  })

  window.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return
    const { id, active } = drag
    const target = over
    end()
    if (!active) return
    swallowNextClick()
    if (target) opts.onMove(id, slotOf(target))
  })

  window.addEventListener('pointercancel', end)

  // Escape abandons a drag in progress without the terminal seeing the key.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !drag?.active) return
      e.stopPropagation()
      e.preventDefault()
      end()
    },
    { capture: true },
  )
}
