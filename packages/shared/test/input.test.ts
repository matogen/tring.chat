import { describe, it, expect } from 'vitest'
import { inputKind } from '../src/input.ts'

const ESC = '\x1b'

describe('inputKind', () => {
  it('reads the mouse reports a wheel notch actually sends', () => {
    // SGR (?1006) is what a modern full-screen app asks for, and what the
    // scroll that started this was arriving as.
    expect(inputKind(`${ESC}[<64;10;20M`)).toBe('navigation')
    expect(inputKind(`${ESC}[<65;10;20M`)).toBe('navigation')
    expect(inputKind(`${ESC}[<0;10;20m`)).toBe('navigation')
    expect(inputKind(`${ESC}[32;10;20M`)).toBe('navigation') // urxvt
    expect(inputKind(`${ESC}[M ()`)).toBe('navigation') // the original three bytes
  })

  it('reads the arrow keys a wheel notch becomes on the alternate screen', () => {
    for (const key of ['A', 'B', 'C', 'D']) {
      expect(inputKind(`${ESC}[${key}`)).toBe('navigation')
      expect(inputKind(`${ESC}O${key}`)).toBe('navigation') // application cursor
    }
    expect(inputKind(`${ESC}[1;5A`)).toBe('navigation') // ctrl+up
  })

  it('reads one wheel notch sent as several arrows in a single write', () => {
    expect(inputKind(`${ESC}[A${ESC}[A${ESC}[A`)).toBe('navigation')
    expect(inputKind(`${ESC}[<64;1;1M${ESC}[<64;1;1M`)).toBe('navigation')
  })

  it('reads the page and home keys', () => {
    for (const seq of ['[5~', '[6~', '[1~', '[4~', '[7~', '[8~', '[H', '[F', 'OH', 'OF']) {
      expect(inputKind(ESC + seq)).toBe('navigation')
    }
  })

  it('reads the focus reports a click makes the terminal send', () => {
    // An app with ?1004h on redraws on both, and clicking around the ring
    // produces a pair every time.
    expect(inputKind(`${ESC}[I`)).toBe('navigation')
    expect(inputKind(`${ESC}[O`)).toBe('navigation')
  })

  it('calls anything that could start work a command', () => {
    expect(inputKind('\r')).toBe('command')
    expect(inputKind('\n')).toBe('command')
    expect(inputKind('npm test\r')).toBe('command')
    expect(inputKind('y')).toBe('command')
    expect(inputKind('\x03')).toBe('command') // ctrl+c
    expect(inputKind('\x7f')).toBe('command') // backspace
    expect(inputKind(`${ESC}[3~`)).toBe('command') // delete
    expect(inputKind(ESC)).toBe('command') // a bare escape
  })

  it('does not let an arrow key carry a command in behind it', () => {
    expect(inputKind(`${ESC}[A\r`)).toBe('command')
    expect(inputKind(`${ESC}[A${ESC}[Bhello`)).toBe('command')
  })

  it('treats a pasted arrow sequence as a command, since paste is bracketed', () => {
    expect(inputKind(`${ESC}[200~${ESC}[A${ESC}[201~`)).toBe('command')
  })

  it('calls an empty write a command rather than opening the window for free', () => {
    expect(inputKind('')).toBe('command')
  })
})
