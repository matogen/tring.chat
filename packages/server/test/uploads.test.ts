import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NotAnImage, sniffImage, UploadStore } from '../src/uploads.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function store(keep?: number): Promise<{ dir: string; uploads: UploadStore }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tring-up-'))
  dirs.push(base)
  const dir = path.join(base, 'uploads')
  return { dir, uploads: new UploadStore(dir, keep) }
}

const png = (): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
const jpeg = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)])
const webp = (): Buffer =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)])

describe('sniffImage', () => {
  it('knows the four types Claude Code can read', () => {
    expect(sniffImage(png())).toBe('.png')
    expect(sniffImage(jpeg())).toBe('.jpg')
    expect(sniffImage(Buffer.from('GIF89a and then some'))).toBe('.gif')
    expect(sniffImage(webp())).toBe('.webp')
  })

  it('refuses anything else, whatever the caller called it', () => {
    expect(sniffImage(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toBeNull()
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />'))).toBeNull()
    expect(sniffImage(Buffer.from('MZ\x90\x00'))).toBeNull() // a windows binary
    expect(sniffImage(Buffer.alloc(0))).toBeNull()
  })

  it('does not mistake a plain RIFF container for a WebP', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])
    expect(sniffImage(wav)).toBeNull()
  })
})

describe('UploadStore', () => {
  it('writes the bytes and hands back a path the shell can open', async () => {
    const { dir, uploads } = await store()
    const file = await uploads.save(png())

    expect(path.dirname(file)).toBe(dir)
    expect(path.extname(file)).toBe('.png')
    expect(await readFile(file)).toEqual(png())
  })

  it('names the file itself, so nothing a caller sends reaches a path', async () => {
    const { dir, uploads } = await store()
    const a = await uploads.save(png())
    const b = await uploads.save(png())

    expect(a).not.toBe(b)
    for (const file of [a, b]) {
      expect(path.basename(file)).toMatch(/^[0-9a-f]{16}\.png$/)
      expect(path.resolve(file).startsWith(path.resolve(dir) + path.sep)).toBe(true)
    }
  })

  it('keeps the directory and the files to their owner', async () => {
    const { dir, uploads } = await store()
    const file = await uploads.save(png())
    // Not meaningful on Windows, where chmod only carries the write bit.
    if (process.platform === 'win32') return
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('refuses a file that is not an image, however it was labelled', async () => {
    const { uploads } = await store()
    await expect(uploads.save(Buffer.from('#!/bin/sh\necho pwned\n'))).rejects.toBeInstanceOf(NotAnImage)
  })

  it('prunes the oldest drops rather than growing without limit', async () => {
    const { dir, uploads } = await store(3)
    for (let i = 0; i < 6; i++) {
      await uploads.save(png())
      await new Promise((r) => setTimeout(r, 12)) // distinct mtimes
    }
    expect((await readdir(dir)).length).toBe(3)
  })

  it('keeps the newest, which is the one just dropped', async () => {
    const { uploads } = await store(1)
    await uploads.save(png())
    await new Promise((r) => setTimeout(r, 12))
    const newest = await uploads.save(jpeg())
    expect(await readFile(newest)).toEqual(jpeg())
  })

  it('takes the whole directory with it on shutdown', async () => {
    const { dir, uploads } = await store()
    await uploads.save(png())
    await uploads.dispose()
    await expect(stat(dir)).rejects.toThrow()
  })

  it('shrugs at a dispose with nothing to clean up', async () => {
    const { uploads } = await store()
    await expect(uploads.dispose()).resolves.toBeUndefined()
  })

  it('survives a directory it cannot prune', async () => {
    const { dir, uploads } = await store(1)
    await uploads.save(png())
    // A stray entry the prune cannot stat away should not fail the next drop.
    await writeFile(path.join(dir, 'note.txt'), 'x')
    await expect(uploads.save(png())).resolves.toContain('.png')
  })
})
