/**
 * Just enough Markdown for what agents write: headings, paragraphs, lists,
 * fenced code, quotes, tables, rules, and inline code, bold, italics,
 * strikethrough and links.
 *
 * The text is an agent's, which makes it untrusted: it is never handed to
 * innerHTML. The parser below is pure and produces a small tree; the renderer
 * turns that tree into DOM nodes with textContent only, and a link is only a
 * link when it is http(s).
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em' | 'del'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] }

export type Block =
  | { t: 'heading'; level: number; children: Inline[] }
  | { t: 'para'; children: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: { depth: number; children: Inline[] }[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; children: Inline[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

const isTableRow = (line: string): boolean => line.includes('|') && line.trim().length > 1

function cells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** Starts a block of its own, so a paragraph ends before it. */
function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || BULLET.test(line) ||
    ORDERED.test(line) || QUOTE.test(line) ||
    (isTableRow(line) && next !== undefined && TABLE_RULE.test(next))
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i++; continue }

    const fence = FENCE.exec(line)
    if (fence) {
      const close = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) body.push(lines[i++]!)
      i++ // the closing fence, or past the end when it never came
      out.push({ t: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ t: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!) })
      i++
      continue
    }

    if (HR.test(line)) { out.push({ t: 'hr' }); i++; continue }

    if (isTableRow(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const head = cells(line).map(parseInline)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && isTableRow(lines[i]!) && lines[i]!.trim()) {
        rows.push(cells(lines[i]!).map(parseInline))
        i++
      }
      out.push({ t: 'table', head, rows })
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!)
      out.push({ t: 'quote', children: parseInline(body.join('\n')) })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet || ordered) {
      const isOrdered = !bullet
      const items: { depth: number; children: Inline[] }[] = []
      const start = ordered ? Number(ordered[2]) : 1
      while (i < lines.length) {
        const l = lines[i]!
        const b = BULLET.exec(l)
        const o = b ? null : ORDERED.exec(l)
        const m = b ?? o
        if (m) {
          const indent = m[1]!.replace(/\t/g, '    ').length
          const text = b ? b[2]! : o![3]!
          items.push({ depth: Math.min(3, Math.floor(indent / 2)), children: parseInline(text) })
          i++
          continue
        }
        // A wrapped item continues on an indented line.
        if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          const last = items[items.length - 1]!
          last.children.push({ t: 'text', text: ' ' }, ...parseInline(l.trim()))
          i++
          continue
        }
        break
      }
      out.push({ t: 'list', ordered: isOrdered, start, items })
      continue
    }

    const para: string[] = [line]
    i++
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!, lines[i + 1])) para.push(lines[i++]!)
    out.push({ t: 'para', children: parseInline(para.join('\n')) })
  }
  return out
}

const URL_RE = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_~]/

/** Inline spans. Unclosed markers stay as the characters they were. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = (): void => { if (text) { out.push({ t: 'text', text }); text = '' } }
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    const rest = src.slice(i)

    if (c === '\\' && i + 1 < src.length && /[\\`*_~[\]()#|>-]/.test(src[i + 1]!)) {
      text += src[i + 1]
      i += 2
      continue
    }

    if (c === '`') {
      const run = /^`+/.exec(rest)![0]
      const end = src.indexOf(run, i + run.length)
      if (end > 0) {
        flush()
        out.push({ t: 'code', text: src.slice(i + run.length, end).replace(/^ (.*) $/, '$1') })
        i = end + run.length
        continue
      }
      text += run
      i += run.length
      continue
    }

    if (c === '[') {
      const m = /^\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest)
      if (m) {
        flush()
        out.push({ t: 'link', href: m[2]!, children: parseInline(m[1]!) })
        i += m[0].length
        continue
      }
    }

    if (c === 'h' && (i === 0 || !/\w/.test(src[i - 1]!))) {
      const m = URL_RE.exec(rest)
      if (m) {
        flush()
        out.push({ t: 'link', href: m[0], children: [{ t: 'text', text: m[0] }] })
        i += m[0].length
        continue
      }
    }

    const span = delimited(src, i)
    if (span) {
      flush()
      out.push({ t: span.t, children: parseInline(span.inner) })
      i = span.end
      continue
    }

    text += c
    i++
  }
  flush()
  return out
}

/**
 * `**bold**`, `__bold__`, `*em*`, `_em_`, `~~del~~` opening at `i`.
 *
 * Underscores only count at word edges, so snake_case_names stay as they are,
 * and a marker followed by a space opens nothing (`2 * 3 * 4`).
 */
function delimited(src: string, i: number): { t: 'strong' | 'em' | 'del'; inner: string; end: number } | null {
  for (const [mark, t] of [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']] as const) {
    if (!src.startsWith(mark, i)) continue
    const open = i + mark.length
    if (open >= src.length || /\s/.test(src[open]!)) return null
    if (mark[0] === '_' && i > 0 && /\w/.test(src[i - 1]!)) return null
    let at = open
    while (true) {
      let end = src.indexOf(mark, at + 1)
      if (end < 0) return null
      // `**a *b***`: the bold closes on the last two of the run, not the first.
      if (mark.length === 2) while (src[end + 2] === mark[0]) end++
      const after = src[end + mark.length]
      const doubled = mark.length === 1 && (src[end + 1] === mark || src[end - 1] === mark)
      const closesWord = mark[0] !== '_' || after === undefined || !/\w/.test(after)
      if (!/\s/.test(src[end - 1]!) && !doubled && closesWord) {
        return { t, inner: src.slice(open, end), end: end + mark.length }
      }
      at = end
    }
  }
  return null
}

/** Only http(s) becomes a link; anything else (javascript:, data:) stays text. */
export function safeHref(href: string): string | null {
  try {
    const u = new URL(href)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

function inlineNodes(parent: HTMLElement, nodes: Inline[]): void {
  for (const n of nodes) {
    if (n.t === 'text') { appendText(parent, n.text); continue }
    if (n.t === 'code') {
      const code = document.createElement('code')
      code.textContent = n.text
      parent.append(code)
      continue
    }
    if (n.t === 'link') {
      const href = safeHref(n.href)
      if (!href) { inlineNodes(parent, n.children); continue }
      const a = document.createElement('a')
      a.href = href
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      inlineNodes(a, n.children)
      parent.append(a)
      continue
    }
    const tag = n.t === 'strong' ? 'strong' : n.t === 'em' ? 'em' : 'del'
    const el = document.createElement(tag)
    inlineNodes(el, n.children)
    parent.append(el)
  }
}

/** Line breaks inside a paragraph are kept: agents wrap on purpose. */
function appendText(parent: HTMLElement, text: string): void {
  const parts = text.split('\n')
  parts.forEach((p, i) => {
    if (i > 0) parent.append(document.createElement('br'))
    if (p) parent.append(document.createTextNode(p))
  })
}

/** The tree as DOM, under a `.md` element styled in style.css. */
export function renderMarkdown(src: string, cls = 'md'): HTMLElement {
  const root = document.createElement('div')
  root.className = cls
  for (const b of parseMarkdown(src)) {
    switch (b.t) {
      case 'heading': {
        const h = document.createElement(`h${Math.min(6, b.level + 2)}` as 'h3')
        inlineNodes(h, b.children)
        root.append(h)
        break
      }
      case 'para': {
        const p = document.createElement('p')
        inlineNodes(p, b.children)
        root.append(p)
        break
      }
      case 'quote': {
        const q = document.createElement('blockquote')
        inlineNodes(q, b.children)
        root.append(q)
        break
      }
      case 'code': {
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        code.textContent = b.text
        if (b.lang) pre.dataset['lang'] = b.lang
        pre.append(code)
        root.append(pre)
        break
      }
      case 'hr':
        root.append(document.createElement('hr'))
        break
      case 'list': {
        const list = document.createElement(b.ordered ? 'ol' : 'ul')
        if (b.ordered && b.start !== 1) list.setAttribute('start', String(b.start))
        for (const item of b.items) {
          const li = document.createElement('li')
          if (item.depth) li.style.marginLeft = `${item.depth * 1.2}em`
          inlineNodes(li, item.children)
          list.append(li)
        }
        root.append(list)
        break
      }
      case 'table': {
        const wrap = document.createElement('div')
        wrap.className = 'md-table'
        const table = document.createElement('table')
        const thead = document.createElement('thead')
        const hr = document.createElement('tr')
        for (const c of b.head) {
          const th = document.createElement('th')
          inlineNodes(th, c)
          hr.append(th)
        }
        thead.append(hr)
        const tbody = document.createElement('tbody')
        for (const row of b.rows) {
          const tr = document.createElement('tr')
          for (const c of row) {
            const td = document.createElement('td')
            inlineNodes(td, c)
            tr.append(td)
          }
          tbody.append(tr)
        }
        table.append(thead, tbody)
        wrap.append(table)
        root.append(wrap)
        break
      }
    }
  }
  return root
}
