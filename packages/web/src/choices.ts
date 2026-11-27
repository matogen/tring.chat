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
 * Other agents write a round their own way, and those count too:
 *
 *   ❓ Q1: Where does draft "Run now" run?        ### Q1. Where should it live?
 *   Scenario: a paragraph of context.              **A.** In Settings
 *   A. Keep it in the browser…                     Why, on the next line.
 *   B. Move it to the server…                      **B.** On the card (recommended)
 *   ➡️ A. Then I'll update the ADR.
 *                                                  1. Which database?
 *   Option A: Retry it twice                          a) Redis
 *   Option B: Fix the race                            b) Postgres
 *   Recommended: B                                 2. How long should entries live?
 *                                                     a) One hour …
 *
 * Conservative on purpose: a wrong button is worse than none, and agents end
 * most turns with a numbered list nobody is asked to pick from ("It will:
 * 1. Check staging 2. …"). A run of options needs consecutive keys (a, b, c…
 * or 1, 2, 3…), at least two of them, and one of these:
 *
 * - The line just above it asks: it ends in "?" ("Which approach do you
 *   prefer?"), or its last sentence says to pick ("Pick one:", "Some
 *   options:", "(choose one)"). "It will:", "Next steps:", "I fixed three
 *   things:" introduce a list, and a "?" further up does not reach past them.
 * - A recommendation after it names one of its keys: "➡️ A.", "Recommended: B".
 * - It is lettered, under a question the agent marked (❓, Q1, a numbered
 *   question) with a ❓ or a "?", however much scenario sits between, unless
 *   the line just above it introduces a list instead ("You picked A. It will:").
 */

export interface Choice {
  /** "a", "b"… or "1", "2"…, lower case. */
  key: string
  /** The key as the agent wrote it, "A" or "a", for the answer. */
  mark: string
  /** The key in the agent's own form, "(a)", "a)" or "A.", for a reply to several questions. */
  written: string
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
/** A message longer than this is not a round anyone answers. The work is linear, so this is generous. */
const MAX_MESSAGE = 200_000
/** Lines of explanation allowed between one option and the next. */
const MAX_BETWEEN = 8
const LETTERS = 'abcdefghijkl'

/** **bold**, __bold__, *em*, `code` markers out; the text stays. */
function plain(s: string): string {
  return s.replace(/\*\*|__|`/g, '').replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,:;!?]|$)/g, '$1$2').trim()
}

/**
 * One option line: an optional bullet, an optional "Option", then a key —
 * (a) a) a. a: (1) 1) 1. — then the text. Upper-case letters count as their
 * lower-case selves.
 */
const OPTION = /^\s*(?:[-*•]\s+)?(?:option\s+)?(?:\(([A-Za-z]|\d{1,2})\)|([A-Za-z]|\d{1,2})([.):]))\s+(\S.*)$/i

/** "Something else you'd like", "Other", "None of these": these open the reply box. */
const OTHER = /^(something else|other\b|another\b|none of (the|these|those)|custom\b|your own|i('ll| will) (type|write|describe)|let me (type|write|describe)|write (my|your) own)/i

/** "(recommended)", "— recommended", "(my pick)" in an option's own text. */
const MARKED = /\((?:recommended|my pick|suggested)\)|\s[—–-]\s*recommended\b/i

/**
 * Words that say the list is a choice, in the sentence that leads into it. Not
 * a bare "which" or "answer": "here's which files changed:" introduces a list
 * of findings, not a question.
 */
const PICK = /\b(choose|choice|choices|pick|select|options?|prefer|decide|vote|go with|which (?:one|of|do you|would you|should)|would you like|do you want|should I|shall I)\b/i

/** A line marking the agent's recommendation: ➡️, or "Recommended: …". */
const RECOMMEND = /^\s*(?:➡️|➡|→|=>|recommend(?:ed|ation)?\b|my (?:pick|recommendation|suggestion)\b|i(?:'d| would)? (?:suggest|recommend|go with)\b)/i

/** The recommendation's lead-in, to see which key comes straight after it. */
const RECOMMEND_LEAD = /^\s*(?:➡️|➡|→|=>)?\s*(?:(?:recommend(?:ed|ation)?|my (?:pick|recommendation|suggestion))\s*:?\s*)?/i

/** A key named in a recommendation: "➡️ A. Then…", "Recommended: B", (a), a), option a. */
function keyIn(line: string): string | null {
  const rest = plain(line).replace(RECOMMEND_LEAD, '')
  const lead = /^(?:option\s+)?([A-Za-z]|\d{1,2})(?:[.:,)]|\s+[—–-]\s|\s*$)/i.exec(rest)
  if (lead) return lead[1]!.toLowerCase()
  const m = /\(([A-Za-z]|\d{1,2})\)|\boption\s+([A-Za-z]|\d{1,2})\b|(?:^|\s)([A-Za-z]|\d{1,2})\)/i.exec(line)
  const k = m?.[1] ?? m?.[2] ?? m?.[3]
  return k ? k.toLowerCase() : null
}

/** "yes" offered as an answer: "Answer yes to go with (a)", "say yes to accept". */
const YES = /\b(?:answer|say|reply|type|respond|just say)\s+(?:with\s+)?["“'`]*yes\b|\byes\b[^.\n]{0,40}\b(?:accept|go with|take|use)s?\b/i

/** One question's part of the message. */
interface Block {
  lines: string[]
  /** "Q1" when the agent numbered the question. */
  id: string | null
  /** The agent marked where the question starts (❓, Q1, a numbered question), so all of it is the question. */
  marked: boolean
}

const RULE = /^\s*(?:[-*]\s*){3,}$/
/** "❓ …", "### Q1. …", "**Q2** - …", "Question 3: …": a question starting. */
const QUESTION_START = /^\s*(?:❓|(?:#{1,6}\s*)?(?:\*\*)?\s*Q(?:uestion)?\s*\d{1,2}\b)/i
/** "1. Which database?": a numbered question, when lettered options follow it. */
const NUMBERED_QUESTION = /^\s?(?:\*\*)?(\d{1,2})[.)]\s+(?=.*\?)/

/** "Q1", "Question 2": the agent's own number for the question, if any. */
function questionId(lines: string[]): string | null {
  const first = lines.find((l) => l.trim()) ?? ''
  const m = /^\s*(?:❓\s*)?(?:#{1,6}\s*)?(?:\*\*)?\s*Q(?:uestion)?\s*(\d{1,2})\b/i.exec(first)
  return m ? `Q${m[1]}` : null
}

/**
 * The message split into questions: at ❓, Q1-style starts and ---. A part
 * holding several numbered questions, each with lettered options of its own,
 * is split again at those numbers. Text before the first question is a part
 * of its own, so nothing in the preamble joins Q1.
 */
function blocks(message: string): Block[] {
  const out: string[][] = [[]]
  for (const line of message.replace(/\r\n?/g, '\n').split('\n')) {
    const rule = RULE.test(line)
    if ((rule || QUESTION_START.test(line)) && out[out.length - 1]!.some((l) => l.trim())) out.push([])
    if (!rule) out[out.length - 1]!.push(line)
  }
  return out.filter((b) => b.some((l) => l.trim())).flatMap((lines) => {
    const id = questionId(lines)
    const marked = id !== null || /^\s*❓/.test(lines.find((l) => l.trim()) ?? '')
    return numberedQuestions(lines) ?? [{ lines, id, marked }]
  })
}

/** The part split at "1. …?", "2. …?" lines, if it holds two or more such questions, each with lettered options. */
function numberedQuestions(lines: string[]): Block[] | null {
  const starts = lines.flatMap((l, i) => (NUMBERED_QUESTION.test(l) ? [i] : []))
  if (starts.length < 2) return null
  const parts = starts.map((s, n) => lines.slice(s, starts[n + 1] ?? lines.length))
  if (!parts.every((p) => runsIn(p.slice(1))[0]?.options[0]?.key === 'a')) return null
  const head = lines.slice(0, starts[0])
  const before: Block[] = head.some((l) => l.trim()) ? [{ lines: head, id: null, marked: false }] : []
  return [...before, ...parts.map((p) => ({ lines: p, id: `Q${NUMBERED_QUESTION.exec(p[0]!)![1]}`, marked: true }))]
}

function questionTitle(lines: string[]): string {
  const first = plain(lines.find((l) => l.trim()) ?? '')
    .replace(/^❓\s*/, '').replace(/^#{1,6}\s*/, '').replace(/^\d{1,2}[.)]\s+/, '')
  // "Q1 - What's the file about?: body" -> "What's the file about?"
  const m = /^Q(?:uestion)?\s*\d{1,2}\s*[-–—:.]\s*(.+?)(?::\s|$)/i.exec(first)
  const t = (m?.[1] ?? first).trim()
  return t.length > 80 ? `${t.slice(0, 79)}…` : t
}

interface Option { key: string; mark: string; written: string; label: string }
/** A run of options: the line it starts on, the line after its last option, and the options. */
interface Run { start: number; end: number; options: Option[] }

/**
 * Every run of options in a block: keys in order from a or 1, two or more.
 * Each option may have a few lines of explanation under it; a recommendation
 * or a new question ends the run.
 */
function runsIn(raw: string[]): Run[] {
  // "- **(a)** One hour": the bold goes before the key is looked for.
  const lines = raw.map((l) => l.replace(/\*\*|__/g, ''))
  const runs: Run[] = []
  for (let i = 0; i < lines.length; i++) {
    const first = OPTION.exec(lines[i]!)
    if (!first) continue
    const key = (first[1] ?? first[2]!).toLowerCase()
    if (key !== 'a' && key !== '1') continue
    const numeric = key === '1'
    const options: Option[] = []
    let j = i
    let end = i + 1
    let between = 0
    while (j < lines.length && options.length < MAX_OPTIONS) {
      const line = lines[j]!
      if (!line.trim()) { j++; continue } // a blank line between options is fine
      const m = OPTION.exec(line)
      if (!m) {
        if (RECOMMEND.test(line) || QUESTION_START.test(line) || ++between > MAX_BETWEEN) break
        j++
        continue
      }
      const mark = m[1] ?? m[2]!
      const k = mark.toLowerCase()
      const want = numeric ? String(options.length + 1) : LETTERS[options.length]
      if (k !== want) break
      options.push({ key: k, mark, written: m[1] ? `(${mark})` : m[3] === ")" ? `${mark})` : `${mark}.`, label: plain(m[4]!) })
      between = 0
      end = ++j
    }
    if (options.length >= 2) {
      runs.push({ start: i, end, options })
      i = end - 1
    }
  }
  return runs
}

/**
 * The line leads into a choice: it ends in a question ("Which one?", "Store
 * tokens where? (choose one)"), or its last sentence says to pick and is not a
 * statement ("Pick one:", "Some options:", "Pick the runtimes (choose any)").
 * Only the last sentence: "I looked at the options. It will:" leads into steps.
 */
function asks(line: string): boolean {
  const t = plain(line).replace(/[*_\s]+$/, '')
  if (/\?\s*(?:\([^)]*\))?\s*:?$/.test(t)) return true
  const last = t.split(/(?<=[.!?])\s+(?=\S)/).pop() ?? t
  return PICK.test(last) && !/\.$/.test(last)
}

/** The line introduces a list that is not a choice: "It will:", "Next steps:", "Done:". */
function introduces(line: string): boolean {
  return /:\s*$/.test(plain(line)) && !asks(line)
}

/** The key a recommendation just after the run names, if it is one of the run's. */
function recommendationFor(lines: string[], run: Run): string | null {
  const keys = new Set(run.options.map((o) => o.key))
  for (const line of lines.slice(run.end, run.end + MAX_BETWEEN + 1)) {
    if (OPTION.test(line.replace(/\*\*|__/g, ''))) break // the next list, not this one's verdict
    if (!RECOMMEND.test(line.replace(/\*\*|__/g, ''))) continue
    const k = keyIn(line)
    if (k && keys.has(k)) return k
  }
  return null
}

/** Whether a run is a choice the user is asked to make: the rules at the top of this file. */
function isChoice(block: Block, run: Run): boolean {
  const lead = block.lines.slice(0, run.start).reverse().find((l) => l.trim()) ?? ''
  if (asks(lead) || recommendationFor(block.lines, run)) return true
  if (!block.marked || run.options[0]!.key !== 'a' || introduces(lead)) return false
  const above = block.lines.slice(0, run.start)
  return /^\s*❓/.test(above.find((l) => l.trim()) ?? '') || above.some((l) => plain(l).includes('?'))
}

export function parseChoices(message: string): ChoiceQuestion[] {
  if (!message || message.length > MAX_MESSAGE) return []
  const out: ChoiceQuestion[] = []
  for (const block of blocks(message)) {
    const lines = block.lines
    // The last run that is a choice: a list of what was done can come first.
    const found = runsIn(lines).filter((r) => isChoice(block, r)).pop()
    if (!found) continue
    const recommended = recommendationFor(lines, found) ?? found.options.find((o) => MARKED.test(o.label))?.key ?? null
    // The grilling skill words every question so "yes" takes its ➡️ answer;
    // anything else has to say so.
    const text = lines.join('\n')
    const acceptsYes = recommended !== null && (/^\s*➡️/m.test(text) || YES.test(plain(text)))
    out.push({
      id: block.id,
      title: questionTitle(lines),
      options: found.options.map((o) => ({ ...o, other: OTHER.test(o.label), recommended: o.key === recommended })),
      acceptsYes,
    })
  }
  // Several questions are only trusted when the agent numbered them; an
  // unnumbered message with two lists is too likely to be something else.
  if (out.length > 1 && out.some((q) => q.id === null)) return []
  return out
}

/** What a button sends: the key as the agent wrote it and its text, unambiguous even if the agent scrolled. */
export function answerText(c: Choice): string {
  return `(${c.mark}) ${c.label}`
}

/**
 * One question's line in a reply to several, "Q1: A. Keep it in the browser…"
 * or "Q2: (a) Daily": the key as the agent wrote it, and enough text to be sure.
 */
export function shortAnswer(c: Choice, max = 60): string {
  if (c.label.length <= max) return `${c.written} ${c.label}`
  const cut = c.label.slice(0, max + 1)
  const at = cut.lastIndexOf(' ')
  return `${c.written} ${(at > max / 2 ? cut.slice(0, at) : c.label.slice(0, max)).replace(/[\s,;:]+$/, '')}…`
}
