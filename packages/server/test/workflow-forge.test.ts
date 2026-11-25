import { describe, it, expect } from 'vitest'
import { Forge } from '../src/workflow/forge.ts'

/** gh, answering with `json` for `pr view`, and remembering what it was asked. */
function gh(json: unknown, fail = false) {
  const asked: string[][] = []
  const forge = new Forge(async (args) => {
    asked.push(args)
    if (fail) throw new Error('gh: not logged in')
    return JSON.stringify(json)
  })
  return { forge, asked }
}

describe('Forge', () => {
  it('reads a GitHub PR\'s state and its checks with gh', async () => {
    const { forge, asked } = gh({
      state: 'OPEN',
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'SUCCESS' },
      ],
    })
    expect(await forge.pr('https://github.com/o/r/pull/12')).toEqual({ state: 'open', ci: 'green' })
    expect(asked).toEqual([['pr', 'view', 'https://github.com/o/r/pull/12', '--json', 'state,statusCheckRollup']])
  })

  it('calls CI red on any failure and pending while anything runs', async () => {
    expect((await gh({ state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }] }).forge.pr('https://github.com/o/r/pull/1'))!.ci).toBe('red')
    expect((await gh({ state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'QUEUED' }] }).forge.pr('https://github.com/o/r/pull/1'))!.ci).toBe('pending')
    expect((await gh({ state: 'OPEN', statusCheckRollup: [{ state: 'ERROR' }] }).forge.pr('https://github.com/o/r/pull/1'))!.ci).toBe('red')
    expect((await gh({ state: 'OPEN', statusCheckRollup: [] }).forge.pr('https://github.com/o/r/pull/1'))!.ci).toBeNull()
  })

  it('knows a merged and a closed PR', async () => {
    expect((await gh({ state: 'MERGED', statusCheckRollup: [] }).forge.pr('https://github.com/o/r/pull/1'))!.state).toBe('merged')
    expect((await gh({ state: 'CLOSED', statusCheckRollup: [] }).forge.pr('https://github.com/o/r/pull/1'))!.state).toBe('closed')
  })

  it('leaves Bitbucket and other forges to the Mark merged button, and asks gh nothing for them', async () => {
    const { forge, asked } = gh({})
    expect(await forge.pr('https://bitbucket.org/o/r/pull-requests/3')).toBeNull()
    expect(asked).toEqual([])
  })

  it('says nothing when gh cannot answer, rather than guessing', async () => {
    expect(await gh({}, true).forge.pr('https://github.com/o/r/pull/1')).toBeNull()
  })
})
