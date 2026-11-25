import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Forge, bitbucketCreds, parseOrigin, type BitbucketCreds } from '../src/workflow/forge.ts'

/** gh, answering with `out` (JSON unless a string), and remembering what it was asked. */
function gh(out: unknown, fail = false) {
  const asked: string[][] = []
  const forge = new Forge({
    gh: async (args) => {
      asked.push(args)
      if (fail) throw new Error('gh: not logged in')
      return typeof out === 'string' ? out : JSON.stringify(out)
    },
  })
  return { forge, asked }
}

interface Call { method: string; url: string; auth: string | null; body: unknown }

/** api.bitbucket.org, answering each request from `routes` by method and path. */
function bitbucket(routes: Record<string, { status?: number; json?: unknown }>, creds: BitbucketCreds | null = { token: 'tok-123' }) {
  const calls: Call[] = []
  const forge = new Forge({
    bitbucket: () => creds,
    fetch: async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const headers = new Headers(init?.headers)
      calls.push({ method, url, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null })
      const route = routes[`${method} ${new URL(url).pathname}`]
      if (!route) return new Response('{"error":{"message":"not found"}}', { status: 404 })
      return new Response(JSON.stringify(route.json ?? {}), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
    },
  })
  return { forge, calls }
}

const API = '/2.0/repositories/matogen/cypherview'
const PR_URL = 'https://bitbucket.org/matogen/cypherview/pull-requests/42'

describe('parseOrigin', () => {
  it('knows GitHub and Bitbucket remotes over HTTPS and SSH', () => {
    expect(parseOrigin('https://github.com/o/r.git')).toEqual({ host: 'github', owner: 'o', repo: 'r' })
    expect(parseOrigin('git@github.com:o/r.git')).toEqual({ host: 'github', owner: 'o', repo: 'r' })
    expect(parseOrigin('https://someone@bitbucket.org/matogen/cypherview.apps.runtime.git'))
      .toEqual({ host: 'bitbucket', owner: 'matogen', repo: 'cypherview.apps.runtime' })
    expect(parseOrigin('git@bitbucket.org:matogen/cypherview.git')).toEqual({ host: 'bitbucket', owner: 'matogen', repo: 'cypherview' })
    expect(parseOrigin('ssh://git@bitbucket.org/matogen/cypherview')).toEqual({ host: 'bitbucket', owner: 'matogen', repo: 'cypherview' })
  })

  it('knows nothing else', () => {
    expect(parseOrigin('https://gitlab.com/o/r.git')).toBeNull()
    expect(parseOrigin('/srv/git/r.git')).toBeNull()
  })
})

describe('Forge on GitHub, through gh', () => {
  it('reads a PR\'s state and its checks', async () => {
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

  it('says nothing when gh cannot answer, rather than guessing', async () => {
    expect(await gh({}, true).forge.pr('https://github.com/o/r/pull/1')).toBeNull()
  })

  it('opens a draft PR against the branch below, in the origin\'s repo', async () => {
    const { forge, asked } = gh('Creating draft pull request…\nhttps://github.com/o/r/pull/9\n')
    const r = await forge.open({ origin: 'git@github.com:o/r.git', head: 'feat/CHV-9-2-api', base: 'feat/CHV-9-1-table', title: 'API', body: 'Part 2 of a stack.' })
    expect(r).toEqual({ url: 'https://github.com/o/r/pull/9' })
    expect(asked).toEqual([['pr', 'create', '--repo', 'o/r', '--draft', '--head', 'feat/CHV-9-2-api', '--base', 'feat/CHV-9-1-table', '--title', 'API', '--body', 'Part 2 of a stack.']])
  })

  it('gives the compare link to open by hand when gh cannot', async () => {
    const r = await gh('', true).forge.open({ origin: 'https://github.com/o/r', head: 'feat/a b', base: 'develop', title: 't', body: 'b' })
    expect(r).toEqual({ error: expect.stringMatching(/gh/), link: 'https://github.com/o/r/compare/develop...feat%2Fa%20b?expand=1' })
  })

  it('retargets a PR with gh pr edit', async () => {
    const { forge, asked } = gh('')
    expect(await forge.retarget('https://github.com/o/r/pull/9', 'develop')).toBeNull()
    expect(asked).toEqual([['pr', 'edit', 'https://github.com/o/r/pull/9', '--base', 'develop']])
  })
})

describe('Forge on Bitbucket Cloud, through its REST API', () => {
  it('opens a draft PR from the branch to the one below, with the token as a bearer', async () => {
    const { forge, calls } = bitbucket({ [`POST ${API}/pullrequests`]: { status: 201, json: { id: 42, links: { html: { href: PR_URL } } } } })
    const r = await forge.open({ origin: 'https://someone@bitbucket.org/matogen/cypherview.git', head: 'feature/CHV-9-2-api', base: 'feature/CHV-9-1-table', title: 'API', body: 'Part 2.' })
    expect(r).toEqual({ url: PR_URL })
    expect(calls).toEqual([{
      method: 'POST', url: `https://api.bitbucket.org${API}/pullrequests`, auth: 'Bearer tok-123',
      body: {
        title: 'API', description: 'Part 2.', draft: true, close_source_branch: false,
        source: { branch: { name: 'feature/CHV-9-2-api' } }, destination: { branch: { name: 'feature/CHV-9-1-table' } },
      },
    }])
  })

  it('uses basic auth when an Atlassian account email is given with the token', async () => {
    const { forge, calls } = bitbucket({ [`GET ${API}/pullrequests/42`]: { json: { state: 'OPEN' } }, [`GET ${API}/pullrequests/42/statuses`]: { json: { values: [] } } },
      { token: 'tok-123', email: 'me@example.com' })
    await forge.pr(PR_URL)
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('me@example.com:tok-123').toString('base64')}`)
  })

  it('reads a PR\'s state and the latest status of each build on it', async () => {
    const statuses = {
      values: [
        { key: 'pipeline', state: 'FAILED', updated_on: '2026-11-25T10:00:00Z' },
        { key: 'pipeline', state: 'SUCCESSFUL', updated_on: '2026-11-25T11:00:00Z' },
        { key: 'sonar', state: 'INPROGRESS', updated_on: '2026-11-25T11:00:00Z' },
      ],
    }
    const { forge } = bitbucket({ [`GET ${API}/pullrequests/42`]: { json: { state: 'OPEN' } }, [`GET ${API}/pullrequests/42/statuses`]: { json: statuses } })
    expect(await forge.pr(PR_URL)).toEqual({ state: 'open', ci: 'pending' })
  })

  it('maps Bitbucket\'s states: merged, declined or superseded is closed, a stopped build is red', async () => {
    const one = (state: string, build: string | null) => bitbucket({
      [`GET ${API}/pullrequests/42`]: { json: { state } },
      [`GET ${API}/pullrequests/42/statuses`]: { json: { values: build ? [{ key: 'k', state: build, updated_on: 'x' }] : [] } },
    }).forge.pr(PR_URL)
    expect(await one('MERGED', 'SUCCESSFUL')).toEqual({ state: 'merged', ci: 'green' })
    expect(await one('DECLINED', null)).toEqual({ state: 'closed', ci: null })
    expect(await one('SUPERSEDED', null)).toEqual({ state: 'closed', ci: null })
    expect(await one('OPEN', 'STOPPED')).toEqual({ state: 'open', ci: 'red' })
  })

  it('retargets a PR, keeping its title', async () => {
    const { forge, calls } = bitbucket({
      [`GET ${API}/pullrequests/42`]: { json: { state: 'OPEN', title: 'API' } },
      [`PUT ${API}/pullrequests/42`]: { json: { id: 42 } },
    })
    expect(await forge.retarget(PR_URL, 'develop')).toBeNull()
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { title: 'API', destination: { branch: { name: 'develop' } } } })
  })

  it('without a token reads nothing and opens nothing, and gives the link to open the PR by hand', async () => {
    const { forge, calls } = bitbucket({}, null)
    expect(await forge.pr(PR_URL)).toBeNull()
    const r = await forge.open({ origin: 'git@bitbucket.org:matogen/cypherview.git', head: 'feature/x', base: 'develop', title: 't', body: 'b' })
    expect(r).toEqual({
      error: expect.stringMatching(/no Bitbucket token/),
      link: 'https://bitbucket.org/matogen/cypherview/pull-requests/new?source=feature%2Fx&dest=develop',
    })
    expect(await forge.retarget(PR_URL, 'develop')).toMatch(/no Bitbucket token/)
    expect(calls).toEqual([])
  })

  it('says what the token lacks when Bitbucket refuses it, and never echoes the token', async () => {
    const { forge } = bitbucket({ [`POST ${API}/pullrequests`]: { status: 403, json: { error: { message: 'scope missing' } } } })
    const r = await forge.open({ origin: 'git@bitbucket.org:matogen/cypherview.git', head: 'feature/x', base: 'develop', title: 't', body: 'b' })
    expect('error' in r && r.error).toMatch(/write:pullrequest:bitbucket/)
    expect(JSON.stringify(r)).not.toContain('tok-123')
  })

  it('asks gh nothing about a Bitbucket PR, and the API nothing about a GitHub one', async () => {
    const asked: string[][] = []
    const fetched: string[] = []
    const forge = new Forge({
      gh: async (a) => { asked.push(a); return '{}' },
      fetch: async (u) => { fetched.push(String(u)); return new Response('{}') },
      bitbucket: () => ({ token: 't' }),
    })
    await forge.pr('https://github.com/o/r/pull/1')
    await forge.pr('https://example.com/o/r/pull-requests/1')
    expect(fetched).toEqual([])
    expect(asked).toHaveLength(1)
  })
})

describe('bitbucketCreds', () => {
  it('reads the token from bitbucket.json in the config dir, or from the environment', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tring-bb-'))
    expect(bitbucketCreds(dir, {})).toBeNull()
    expect(bitbucketCreds(dir, { TRING_BITBUCKET_TOKEN: ' env-tok ', TRING_BITBUCKET_EMAIL: 'e@x' })).toEqual({ token: 'env-tok', email: 'e@x' })
    await writeFile(path.join(dir, 'bitbucket.json'), JSON.stringify({ token: 'file-tok' }))
    expect(bitbucketCreds(dir, { TRING_BITBUCKET_TOKEN: 'env-tok' })).toEqual({ token: 'file-tok' })
    await writeFile(path.join(dir, 'bitbucket.json'), 'not json')
    expect(bitbucketCreds(dir, {})).toBeNull()
  })
})
