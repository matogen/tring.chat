import { describe, expect, it } from 'vitest'
import { answerText, parseChoices } from '../src/choices.ts'

/** The card from GENERAL/3, as the grilling skill really writes it (with its markdown). */
const GRILL = [
  "❓ **Q1** - **What's the file about?**: It's a throwaway test file, so let's pick a fun topic. Some options:",
  '- (a) A short letter from a houseplant to its owner, complaining about the watering schedule',
  '- (b) A weather forecast for the inside of a fridge',
  '- (c) A job ad for a professional sock-matcher',
  "- (d) Something else you'd like",
  '',
  "➡️ (a) The houseplant's letter. It has the most personality and keeps the text short.",
  '',
  'Answer yes to go with (a), or choose another.',
].join('\n')

describe('parseChoices: the grilling skill', () => {
  it('reads the round from GENERAL/3: options, the recommended one, yes, and "something else"', () => {
    const [q, ...rest] = parseChoices(GRILL)
    expect(rest).toEqual([])
    expect(q!.id).toBe('Q1')
    expect(q!.title).toBe("What's the file about?")
    expect(q!.acceptsYes).toBe(true)
    expect(q!.options.map((o) => [o.key, o.recommended, o.other])).toEqual([
      ['a', true, false], ['b', false, false], ['c', false, false], ['d', false, true],
    ])
    expect(q!.options[0]!.label).toBe('A short letter from a houseplant to its owner, complaining about the watering schedule')
    expect(answerText(q!.options[1]!)).toBe('(b) A weather forecast for the inside of a fridge')
  })

  it('reads it the same without the markdown, as pasted', () => {
    const q = parseChoices(GRILL.replace(/\*\*/g, ''))
    expect(q).toHaveLength(1)
    expect(q[0]!.options).toHaveLength(4)
  })

  it('reads a round of several numbered questions, each with its own options', () => {
    const round = [
      '❓ **Q1** - **Database**: Which one should back the cache?',
      '1. Redis',
      '2. Postgres',
      '',
      '➡️ 1) Redis, since it is already deployed.',
      '',
      '---',
      '',
      '❓ **Q2** - **Expiry**: How long should entries live? Options:',
      '- **(a)** One hour',
      '- **(b)** One day',
      '',
      '➡️ (b) One day.',
      '',
      '---',
      '',
      '❓ **Q3** - **Naming**: Should the module be called `cache`?',
      '',
      '➡️ Yes, `cache`.',
    ].join('\n')
    const qs = parseChoices(round)
    // Q3 has no options to button: "yes" or a typed reply covers it.
    expect(qs.map((q) => q.id)).toEqual(['Q1', 'Q2'])
    expect(qs[0]!.options.map((o) => o.label)).toEqual(['Redis', 'Postgres'])
    expect(qs[0]!.options[0]!.recommended).toBe(true)
    expect(qs[1]!.options.map((o) => [o.key, o.label, o.recommended])).toEqual([['a', 'One hour', false], ['b', 'One day', true]])
    expect(qs.every((q) => q.acceptsYes)).toBe(true)
  })
})

describe('parseChoices: other plain-text styles', () => {
  it('a numbered list under a question', () => {
    const [q] = parseChoices('Which approach do you prefer?\n\n1. Keep the polling loop\n2. Switch to webhooks\n3. Do both behind a flag')
    expect(q!.id).toBeNull()
    expect(q!.options.map((o) => o.key)).toEqual(['1', '2', '3'])
    expect(q!.acceptsYes).toBe(false)
    expect(q!.options.some((o) => o.recommended)).toBe(false)
  })

  it('a) b) and A. B. styles, upper case read as lower', () => {
    expect(parseChoices('Pick one:\na) Ship it today\nb) Wait for the review')[0]!.options.map((o) => o.label))
      .toEqual(['Ship it today', 'Wait for the review'])
    expect(parseChoices('Choose a layout:\nA. Two columns\nB. Tabs')[0]!.options.map((o) => o.key)).toEqual(['a', 'b'])
  })

  it('a "Recommended:" line, and yes only when the message offers it', () => {
    const msg = 'How should I proceed?\n(a) Rebase onto develop\n(b) Merge develop in\n\nRecommended: option b, it keeps history intact.'
    const [q] = parseChoices(msg)
    expect(q!.options.map((o) => o.recommended)).toEqual([false, true])
    expect(q!.acceptsYes).toBe(false)
    expect(parseChoices(`${msg} Say yes to go with it.`)[0]!.acceptsYes).toBe(true)
  })

  it('a yes/no question as options', () => {
    expect(parseChoices('Should I push the branch?\n1) Yes\n2) No')[0]!.options).toHaveLength(2)
  })
})

describe('parseChoices: what is not a choice', () => {
  it('a bullet list of findings', () => {
    expect(parseChoices('Done. I found:\n- The login redirect loops\n- The CSS is missing\n\nShould I fix both?')).toEqual([])
  })

  it('a numbered list of findings or steps with no question above it', () => {
    expect(parseChoices('I fixed three things:\n1. The login redirect\n2. The CSS\n3. The README')).toEqual([])
    expect(parseChoices("Here's which files changed:\n1. a.ts\n2. b.ts")).toEqual([])
    expect(parseChoices('To deploy:\n1. Run the build\n2. Push the tag\n\nAnything else?')).toEqual([])
  })

  it('a question too far above the list', () => {
    expect(parseChoices('Want me to continue?\n\nMeanwhile, notes.\nMore notes.\nEven more.\n1. One\n2. Two')).toEqual([])
  })

  it('keys out of order, starting late, or a single option', () => {
    expect(parseChoices('Pick one:\n(a) One\n(c) Three')).toEqual([])
    expect(parseChoices('Pick one:\n(b) Two\n(c) Three')).toEqual([])
    expect(parseChoices('Pick one:\n(a) Only this')).toEqual([])
  })

  it('two unnumbered lists in one message', () => {
    expect(parseChoices('Pick a colour:\n(a) Red\n(b) Blue\n\n---\n\nPick a size:\n(a) S\n(b) M')).toEqual([])
  })

  it('a recommendation naming no listed option', () => {
    const [q] = parseChoices('Which one?\n(a) Red\n(b) Blue\n\n➡️ Green, honestly.')
    expect(q!.options.some((o) => o.recommended)).toBe(false)
    expect(q!.acceptsYes).toBe(false)
  })
})
