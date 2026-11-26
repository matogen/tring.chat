import { describe, expect, it } from 'vitest'
import { answerText, parseChoices, shortAnswer } from '../src/choices.ts'

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

/** A real round from a Claude Code tile, where only Q2's options used to show (and with no heading). */
const SCHEDULER = [
  "I've written up the scheduler design. Two decisions are yours before I build it.",
  '',
  'Questions',
  '❓ Q1: Where does draft "Run now" run?',
  '',
  'Scenario: a developer builds a "daily trip summary" app and clicks Run now before publishing.',
  '',
  'A. Keep it in the browser (where it is today), but run the same file as the real 06:00 run. The toolkit runs the app\'s worker/run.js in the hidden frame. Reads use the developer\'s login, and the screen shows "This notification would be sent: Yesterday: 42 trips, 3,180 km". What you test is what runs on schedule, nothing is sent, and the web app doesn\'t change.',
  'B. Move it to the server, through the same supervisor as real runs (what ADR CHV-3061 planned). That catches server-only problems, but a draft has no installation, so it has no identity for reading data. The store would need a new "draft run" identity, which is Kristopher\'s side plus a security review.',
  '➡️ A. Then I\'ll update ADR CHV-3061 to say so.',
  '',
  '❓ Q2: Do runs start exactly on the hour, or spread out a little?',
  '',
  'Scenario: 400 customers pick "Every day at 06:00". At exactly 06:00:00, 400 apps all hit the Fleet API in the same second.',
  '',
  'A. Each installation gets its own fixed minute in the first 10 minutes. Lynx\'s digest always runs at 06:04 and another client\'s always at 06:07: the same time every day, and the load is spread out.',
  'B. Exactly on the hour. Predictable, but every run lands in the same second.',
  'C. Spread across the whole hour. The least load, but "06:00" could mean 06:55.',
  '➡️ A. If you pick A, the schedule option\'s label "Every day at 06:00 UTC" should probably read "around 06:00 UTC". That\'s a one-word change in the generator.',
  '',
  "Defaults I'll use unless you object:",
  '- Times are in UTC.',
  '- A failed run is not retried.',
].join('\n')

describe('parseChoices: questions separated from their options', () => {
  it('reads both questions of the scheduler round, each with its own options and recommendation', () => {
    const qs = parseChoices(SCHEDULER)
    expect(qs.map((q) => q.id)).toEqual(['Q1', 'Q2'])
    expect(qs[0]!.title).toBe('Where does draft "Run now" run?')
    expect(qs[0]!.options.map((o) => [o.key, o.recommended])).toEqual([['a', true], ['b', false]])
    expect(qs[0]!.options[1]!.label).toMatch(/^Move it to the server/)
    expect(qs[1]!.title).toBe('Do runs start exactly on the hour, or spread out a little?')
    expect(qs[1]!.options.map((o) => [o.key, o.recommended])).toEqual([['a', true], ['b', false], ['c', false]])
    expect(qs.every((q) => q.acceptsYes)).toBe(true)
  })

  it('answers in the agent\'s own letters', () => {
    const [q1] = parseChoices(SCHEDULER)
    expect(answerText(q1!.options[1]!)).toMatch(/^\(B\) Move it to the server/)
    expect(shortAnswer(q1!.options[0]!)).toBe('A. Keep it in the browser (where it is today), but run the same…')
  })

  it('reads a message far longer than a screen', () => {
    const long = `${'Some context that goes on. '.repeat(2000)}\n\n${SCHEDULER}`
    expect(long.length).toBeGreaterThan(50_000)
    expect(parseChoices(long).map((q) => q.id)).toEqual(['Q1', 'Q2'])
  })
})

describe('parseChoices: more ways agents write a round', () => {
  it('numbered questions with lettered options under each, and no ❓', () => {
    const msg = [
      'A few decisions before I start:',
      '',
      '1. Which database should back the cache?',
      '   a) Redis',
      '   b) Postgres',
      '2. How long should entries live?',
      '   a) One hour',
      '   b) One day',
      '   c) Forever',
    ].join('\n')
    const qs = parseChoices(msg)
    expect(qs.map((q) => [q.id, q.title, q.options.map((o) => o.label)])).toEqual([
      ['Q1', 'Which database should back the cache?', ['Redis', 'Postgres']],
      ['Q2', 'How long should entries live?', ['One hour', 'One day', 'Forever']],
    ])
  })

  it('### Q1 headings, **A.** options with their explanation on the next line, and "(recommended)"', () => {
    const msg = [
      '### Q1. Where should the toggle live?',
      '',
      '**A.** In Settings',
      'Everything in one place, one more click.',
      '',
      '**B.** On the card (recommended)',
      'One click, but the card gets busier.',
      '',
      '### Q2. Should it default to on?',
      '',
      '**A.** Yes',
      '**B.** No',
    ].join('\n')
    const qs = parseChoices(msg)
    expect(qs.map((q) => q.id)).toEqual(['Q1', 'Q2'])
    expect(qs[0]!.options.map((o) => [o.label, o.recommended])).toEqual([['In Settings', false], ['On the card (recommended)', true]])
    expect(qs[1]!.options.map((o) => o.label)).toEqual(['Yes', 'No'])
  })

  it('"Option A:" keys and a "Recommended: B" line', () => {
    const [q] = parseChoices('Which way should I fix the flaky test?\n\nOption A: Retry it twice\nOption B: Fix the race in the setup\n\nRecommended: B, the retry only hides it.')
    expect(q!.options.map((o) => [o.key, o.label, o.recommended])).toEqual([['a', 'Retry it twice', false], ['b', 'Fix the race in the setup', true]])
  })

  it('an AskUserQuestion prompt cut off by a restart, as the saved card writes it', () => {
    const msg = [
      'tring restarted while this question was open, so the agent never got your answer. Reply to answer it now.',
      '',
      '❓ **Q1** - **Which auth method?**',
      '- (a) OAuth — Sign in with the provider',
      '- (b) API key',
      '',
      '❓ **Q2** - **Store tokens where?** (choose one)',
      '- (a) Keychain',
      '- (b) A file in the config dir',
    ].join('\n')
    expect(parseChoices(msg).map((q) => [q.id, q.options.length])).toEqual([['Q1', 2], ['Q2', 2]])
  })

  it('still nothing for a plain report with no question, however it is laid out', () => {
    expect(parseChoices('### Summary\n\nA. The build passes.\nB. The lint passes.')).toEqual([])
    expect(parseChoices('Done:\n1. Fixed the login\n   Explained in the PR.\n2. Fixed the CSS')).toEqual([])
  })
})
