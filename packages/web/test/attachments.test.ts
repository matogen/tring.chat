import { describe, it, expect } from 'vitest'
import { PendingFiles, nameOf, pastedFiles, replyText, sizeLabel, uploadAll } from '../src/attachments.ts'

const png = (name?: string): Blob => name ? new File(['x'], name, { type: 'image/png' }) : new Blob(['x'], { type: 'image/png' })

describe('PendingFiles', () => {
  it('keeps what was added, in order, and says when it changes', () => {
    let changes = 0
    const p = new PendingFiles(() => { changes++ })
    p.add([png('a.png'), new File(['log'], 'build.log', { type: 'text/plain' })])
    expect(p.list.map((a) => [a.name, a.image])).toEqual([['a.png', true], ['build.log', false]])
    expect(changes).toBe(1)
  })

  it('removes one chip and leaves the rest', () => {
    const p = new PendingFiles()
    const [a, b] = p.add([png('a.png'), png('b.png')])
    p.remove(a!.id)
    expect(p.list.map((x) => x.id)).toEqual([b!.id])
  })

  it('stays quiet when nothing changes', () => {
    let changes = 0
    const p = new PendingFiles(() => { changes++ })
    p.add([])
    p.remove(99)
    p.clear()
    expect(changes).toBe(0)
  })

  it('empties after a send', () => {
    const p = new PendingFiles()
    p.add([png('a.png')])
    p.clear()
    expect(p.list).toEqual([])
  })
})

describe('nameOf', () => {
  it('uses the file name when there is one', () => {
    expect(nameOf(new File(['x'], 'error.jpg', { type: 'image/jpeg' }), 1)).toBe('error.jpg')
  })

  it('names a pasted screenshot, which has none worth showing', () => {
    expect(nameOf(png(), 2)).toBe('pasted image 2.png')
    expect(nameOf(png('image.png'), 3)).toBe('pasted image 3.png')
    expect(nameOf(new Blob(['x'], { type: 'image/jpeg' }), 4)).toBe('pasted image 4.jpg')
    expect(nameOf(new Blob(['x']), 5)).toBe('pasted file 5')
  })
})

describe('pastedFiles', () => {
  const shot = new File(['x'], 'image.png', { type: 'image/png' })

  it('takes a screenshot off the clipboard', () => {
    expect(pastedFiles({ types: ['Files'], files: [shot] })).toEqual([shot])
  })

  it('takes an image copied from a web page, which comes with its HTML', () => {
    expect(pastedFiles({ types: ['text/html', 'Files'], files: [shot] })).toEqual([shot])
  })

  it('leaves a text paste to the box, even when Word put a picture of it beside the text', () => {
    expect(pastedFiles({ types: ['text/plain', 'text/html', 'Files'], files: [shot] })).toEqual([])
  })

  it('finds nothing in an ordinary paste', () => {
    expect(pastedFiles({ types: ['text/plain'], files: [] })).toEqual([])
    expect(pastedFiles(null)).toEqual([])
  })
})

describe('replyText', () => {
  it('puts the paths before the words, as a terminal drop does', () => {
    expect(replyText('this is the error', ['/home/me/.config/tring/uploads/a1.png']))
      .toBe('/home/me/.config/tring/uploads/a1.png this is the error')
  })

  it('quotes a path with a space in it', () => {
    expect(replyText('see', ['C:\\Users\\Some One\\.config\\tring\\uploads\\a1.png', '/tmp/b.log']))
      .toBe('"C:\\Users\\Some One\\.config\\tring\\uploads\\a1.png" /tmp/b.log see')
  })

  it('sends the files alone when nothing was typed', () => {
    expect(replyText('  ', ['/tmp/a.png'])).toBe('/tmp/a.png')
  })

  it('is just the words without files', () => {
    expect(replyText(' go ahead ', [])).toBe('go ahead')
  })
})

describe('uploadAll', () => {
  it('uploads every file in order', async () => {
    const p = new PendingFiles()
    p.add([png('a.png'), png('b.png')])
    const seen: string[] = []
    const paths = await uploadAll(p.list, async (f) => { seen.push((f as File).name); return `/up/${(f as File).name}` })
    expect(seen).toEqual(['a.png', 'b.png'])
    expect(paths).toEqual(['/up/a.png', '/up/b.png'])
  })

  it('fails as a whole, naming the file, so a reply never goes without one of them', async () => {
    const p = new PendingFiles()
    p.add([png('a.png'), png('huge.png'), png('c.png')])
    let calls = 0
    await expect(uploadAll(p.list, async (f) => {
      calls++
      if ((f as File).name === 'huge.png') throw new Error('uploads are limited to 10MB')
      return '/up/x'
    })).rejects.toThrow('huge.png: uploads are limited to 10MB')
    expect(calls).toBe(2)
  })
})

describe('sizeLabel', () => {
  it('reads like a file manager', () => {
    expect(sizeLabel(512)).toBe('512 B')
    expect(sizeLabel(12_345)).toBe('12 KB')
    expect(sizeLabel(3.4 * 1024 * 1024)).toBe('3.4 MB')
  })
})
