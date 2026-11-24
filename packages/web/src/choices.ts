/**
 * Multiple-choice questions an agent asks in plain text at the end of its
 * turn — the grilling skill's rounds above all — read out of its last message
 * so the card can offer one button per option.
 *
 *   ❓ **Q1** - **What's the file about?**: … Some options:
 *   - (a) A short letter from a houseplant …
 *   - (b) A weather forecast for the inside of a fridge
 *   - (d) Something else you'd like
 *   ➡️ (a) The houseplant's letter. …
 *   Answer yes to go with (a), or choose another.
 *
 * Conservative on purpose: a wrong button is worse than none. A run of
 * options counts only with consecutive keys (a, b, c… or 1, 2, 3…), at least
 * two of them, and a cue that it is a choice — a question mark or a word like
 * "choose" or "options" — in the lines just above it. A numbered list of
 * findings with no question in front of it is just a list.
 */

export interface Choice {
  /** "a", "b"… or "1", "2"…, as written. */
  key: string
  /** The option's text, markdown stripped, without the key. */
  label: string
  /** "Something else", "Other": a button that opens the reply box instead of sending. */
  other: boolean
  /** What the agent marked as its recommendation. */
  recommended: boolean
}

export interface ChoiceQuestion {
  /** "Q1" when the agent numbered its questions; null for a single unnumbered one. */
  id: string | null
  /** The question's title or text, short, for a heading when there are several. */
  title: string
  options: Choice[]
  /** Whether the message invites "yes" to accept the recommended option. */
  acceptsYes: boolean
}

const MAX_OPTIONS = 12
const LETTERS = 'abcdefghijkl'

/** **bold**, __bold__, *em*, `code` markers out; the text stays. */
function plain(s: string): string {
  return s.replace(/\*\*|__|`/g, '').replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,:;!?]|$)/g, '$1$2').trim()
}

/**
 * One option line: an optional bullet, then a key — (a) a) a. (1) 1) 1. —
 * then the text. Upper-case letters count as their lower-case selves.
 */
const OPTION = /^\s*(?:[-*•]\s+)?(?:\(([A-Za-z]|\d{1,2})\)|([A-Za-z]|\d{1,2})[.)])\s+(\S.*)$/

/** "Something else you'd like", "Other", "None of these": these open the reply box. */
const OTHER = /^(something else|other\b|another\b|none of (the|these|those)|custom\b|your own|i('ll| will) (type|write|describe)|let me (type|write|describe)|write (my|your) own)/i

/**
 * Words that say the list is a choice. Not a bare "which" or "answer": "here's
 * which files changed:" introduces a list of findings, not a question.
 */
const CUE = /\b(choose|choice|choices|pick|select|options?|prefer|decide|vote|go with|which (?:one|of|do you|would you|should))\b/i

/** A line marking the agent's recommendation: ➡️, or "Recommended: …". */
const RECOMMEND = /^\s*(?:➡️|➡|→|=>|recommend(?:ed|ation)?\b|my (?:pick|recommendation|suggestion)\b|i(?:'d| would)? (?:suggest|recommend|go with)\b)/i

/** A key named in a line: (a), a), option a, "a". */
function keyIn(line: string): string | null {
  const m = /\(([A-Za-z]|\d{1,2})\)|\boption\s+([A-Za-z]|\d{1,2})\b|(?:^|\s)([A-Za-z]|\d{1,2})\)/i.exec(line)
  const k = m?.[1] ?? m?.[2] ?? m?.[3]
  return k ? k.toLowerCase() : null
}

/** "yes" offered as an answer: "Answer yes to go with (a)", "say yes to accept". */
const YES = /\b(?:answer|say|reply|type|respond|just say)\s+(?:with\s+)?["“'`]*yes\b|\byes\b[^.\n]{0,40}\b(?:accept|go with|take|use)s?\b/i

/** The message split into questions: by the grilling skill's ❓ markers or ---, else whole. */
function blocks(message: string): string[] {
  const lines = message.replace(/\r\n?/g, '\n').split('\n')
  const out: string[][] = [[]]
  for (const line of lines) {
    const starts = /^\s*❓/.test(line) || /^\s*(?:[-*]\s*){3,}$/.test(line)
    if (starts && out[out.length - 1]!.some((l) => l.trim())) out.push([])
    if (/^\s*(?:[-*]\s*){3,}$/.test(line)) continue
    out[out.length - 1]!.push(line)
  }
  return out.map((b) => b.join('\n')).filter((b) => b.trim())
}

/** "Q1", "Question 2": the agent's own number for the question, if any. */
function questionId(block: string): string | null {
  const m = /(?:^|❓\s*)(?:\*\*)?\s*Q(?:uestion)?\s*(\d{1,2})\b/i.exec(block.trim())
  return m ? `Q${m[1]}` : null
}

function questionTitle(block: string): string {
  const first = plain(block.split('\n').find((l) => l.trim()) ?? '').replace(/^❓\s*/, '')
  // "Q1 - What's the file about?: body" -> "What's the file about?"
  const m = /^Q(?:uestion)?\s*\d{1,2}\s*[-–—:.]\s*(.+?)(?::\s|$)/i.exec(first)
  const t = (m?.[1] ?? first).trim()
  return t.length > 80 ? `${t.slice(0, 79)}…` : t
}

/** The run of options in a block, if it is one: keys in order from a or 1, two or more. */
function optionsIn(raw: string[]): { start: number; options: Array<{ key: string; label: string }> } | null {
  // "- **(a)** One hour": the bold goes before the key is looked for.
  const lines = raw.map((l) => l.replace(/\*\*|__/g, ''))
  for (let i = 0; i < lines.length; i++) {
    const first = OPTION.exec(lines[i]!)
    if (!first) continue
    const key = (first[1] ?? first[2]!).toLowerCase()
    if (key !== 'a' && key !== '1') continue
    const numeric = key === '1'
    const options: Array<{ key: string; label: string }> = []
    let j = i
    while (j < lines.length && options.length < MAX_OPTIONS) {
      const line = lines[j]!
      if (!line.trim()) { j++; continue } // a blank line between options is fine
      const m = OPTION.exec(line)
      if (!m) break
      const k = (m[1] ?? m[2]!).toLowerCase()
      const want = numeric ? String(options.length + 1) : LETTERS[options.length]
      if (k !== want) break
      options.push({ key: k, label: plain(m[3]!) })
      j++
    }
    if (options.length >= 2) return { start: i, options }
  }
  return null
}

/** The few lines just above the options: where a choice announces itself. */
function cued(lines: string[], start: number): boolean {
  const above = lines.slice(Math.max(0, start - 3), start).map(plain).join(' ')
  return /\?/.test(above) || CUE.test(above)
}

export function parseChoices(message: string): ChoiceQuestion[] {
  if (!message || message.length > 20_000) return []
  const out: ChoiceQuestion[] = []
  for (const block of blocks(message)) {
    const lines = block.split('\n')
    const found = optionsIn(lines)
    if (!found || !cued(lines, found.start)) continue
    const keys = new Set(found.options.map((o) => o.key))
    let recommended: string | null = null
    for (const line of lines.slice(found.start)) {
      if (!RECOMMEND.test(line)) continue
      const k = keyIn(line)
      if (k && keys.has(k)) { recommended = k; break }
    }
    // The grilling skill words every question so "yes" takes its ➡️ answer;
    // anything else has to say so.
    const acceptsYes = recommended !== null && (/^\s*➡️/m.test(block) || YES.test(plain(block)))
    out.push({
      id: questionId(block),
      title: questionTitle(block),
      options: found.options.map((o) => ({ ...o, other: OTHER.test(o.label), recommended: o.key === recommended })),
      acceptsYes,
    })
  }
  // Several questions are only trusted when the agent numbered them; an
  // unnumbered message with two lists is too likely to be something else.
  if (out.length > 1 && out.some((q) => q.id === null)) return []
  return out
}

/** What a button sends: the key and its text, unambiguous even if the agent scrolled. */
export function answerText(c: Choice): string {
  return `(${c.key}) ${c.label}`
}
