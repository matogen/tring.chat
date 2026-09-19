import { describe, expect, it } from 'vitest'
import { imagesIn, sortClipboard, type ClipboardEntry } from '../src/paste.ts'

const file = (type: string): File => new File([new Uint8Array([1, 2, 3])], 'x', { type })

describe('imagesIn', () => {
  it('keeps the images Claude Code can read and drops the rest', () => {
    const png = file('image/png')
    const webp = file('image/webp')
    expect(imagesIn([file('text/plain'), png, file('image/svg+xml'), webp])).toEqual([png, webp])
  })

  it('tolerates a paste with no files at all', () => {
    expect(imagesIn(null)).toEqual([])
    expect(imagesIn(undefined)).toEqual([])
  })
})

const entry = (parts: Record<string, Blob>): ClipboardEntry => ({
  types: Object.keys(parts),
  getType: async (t) => parts[t]!,
})

describe('sortClipboard', () => {
  it('returns plain text as text', async () => {
    const out = await sortClipboard([entry({ 'text/plain': new Blob(['hunter2']) })])
    expect(out).toEqual({ images: [], text: 'hunter2' })
  })

  it('takes the image when an item is both, because that is what was copied', async () => {
    const png = new Blob([new Uint8Array([1])], { type: 'image/png' })
    const out = await sortClipboard([entry({ 'text/html': new Blob(['<img>']), 'image/png': png })])
    expect(out.images).toEqual([png])
    expect(out.text).toBe('')
  })

  it('ignores an image type the daemon would refuse', async () => {
    const out = await sortClipboard([entry({ 'image/svg+xml': new Blob(['<svg/>']) })])
    expect(out).toEqual({ images: [], text: '' })
  })

  it('joins the text of several items in order', async () => {
    const out = await sortClipboard([
      entry({ 'text/plain': new Blob(['a']) }),
      entry({ 'text/plain': new Blob(['b']) }),
    ])
    expect(out.text).toBe('ab')
  })
})
