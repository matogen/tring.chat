import { describe, expect, it } from 'vitest'
import { encodeWav, hasSound, resample, WHISPER_RATE } from '../src/wav.ts'

describe('encodeWav', () => {
  it('writes a 16 kHz mono 16-bit PCM header and clamps the samples', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -1, 2]))
    const v = new DataView(wav.buffer)
    const text = (at: number, n: number): string => String.fromCharCode(...wav.subarray(at, at + n))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(WHISPER_RATE)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint32(40, true)).toBe(8)
    expect(wav.length).toBe(44 + 8)
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 16383, -32768, 32767])
  })
})

describe('resample', () => {
  it('48 kHz to 16 kHz keeps a third of the samples, and the shape', () => {
    const input = Float32Array.from({ length: 48 }, (_, i) => i / 48)
    const out = resample(input, 48_000, 16_000)
    expect(out.length).toBe(16)
    expect(out[0]).toBeCloseTo(0)
    expect(out[15]).toBeCloseTo(45 / 48)
  })
  it('leaves 16 kHz alone', () => {
    const input = new Float32Array([0.1, 0.2])
    expect(resample(input, 16_000, 16_000)).toBe(input)
  })
})

describe('hasSound', () => {
  it('tells speech from silence and a click', () => {
    expect(hasSound(new Float32Array(WHISPER_RATE))).toBe(false)
    expect(hasSound(Float32Array.from({ length: 100 }, () => 0.5))).toBe(false)
    expect(hasSound(Float32Array.from({ length: WHISPER_RATE }, (_, i) => Math.sin(i / 10) * 0.3))).toBe(true)
  })
})
