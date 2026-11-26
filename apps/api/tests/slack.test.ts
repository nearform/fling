/**
 * Link previews in Slack (slack/, routes/slack.ts): only Slack's signed requests are read, the
 * URL check is answered, and a link to a site gets the site's card only when the person who posted
 * it can open the site. A member who is not the author gets one for a members-level site. Every
 * other link gets the neutral card, which reads the same for a site that doesn't exist: a site the
 * poster can't open, an archived site, a Slack account with no Fling user, a share link, any other
 * page. A retry does no work twice.
 */
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { instanceMetadata } from '../src/instance.ts'
import type { SlackClient, SlackUnfurl, UnfurlTarget } from '../src/slack/client.ts'
import { SlackWebClient } from '../src/slack/client.ts'
import { slackSignature } from '../src/slack/signature.ts'
import { siteNameOf } from '../src/slack/unfurl.ts'
import { APP_ORIGIN, api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

const SECRET = 'slack-signing-secret-for-tests'
const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

/** A Slack that knows each user's email by id and records what was unfurled. */
class FakeSlack implements SlackClient {
  calls: { target: UnfurlTarget; unfurls: Record<string, SlackUnfurl> }[] = []
  constructor(private readonly emails: Record<string, string>) {}
  async userEmail(id: string) {
    return this.emails[id] ?? null
  }
  async unfurl(target: UnfurlTarget, unfurls: Record<string, SlackUnfurl>) {
    this.calls.push({ target, unfurls })
  }
}

async function deploy(env: Env, key: string, name: string, access: string) {
  const files = [file('index.html', `<title>${name} deck</title><h1>${name}</h1>`)]
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    access,
  })
  const body = await json(res)
  await upload(env, body.uploads, files)
  await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
}

/** Alice owns `team` (members) and `secret` (only her); Bob is a member; U-ROBOT is no one. */
async function world() {
  const env = setup({})
  env.deps.config.secrets.slackSigningSecret = SECRET
  env.deps.config.secrets.slackBotToken = 'xoxb-test'
  const slack = new FakeSlack({ 'U-ALICE': ALICE, 'U-BOB': BOB, 'U-ROBOT': 'robot@elsewhere.test' })
  const app = createApp({ ...env.deps, slack })
  const alice = await createUser(env, ALICE)
  await createUser(env, BOB)
  await deploy(env, alice.key, 'team', 'members')
  await deploy(env, alice.key, 'secret', 'only_me')
  const now = () => String(Math.floor(env.deps.clock.now().getTime() / 1000))
  const post = (body: unknown, opts: { ts?: string; sig?: string; headers?: object } = {}) => {
    const raw = JSON.stringify(body)
    const ts = opts.ts ?? now()
    return app.request('/api/integrations/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': opts.sig ?? slackSignature(SECRET, ts, raw),
        ...opts.headers,
      },
      body: raw,
    })
  }
  const shared = (user: string, ...urls: string[]) => ({
    type: 'event_callback',
    event: {
      type: 'link_shared',
      user,
      channel: 'C1',
      message_ts: '1700000000.000100',
      source: 'conversations_history',
      links: urls.map(url => ({ url, domain: new URL(url).host })),
    },
  })
  return { env, app, slack, alice, post, shared }
}

describe('the Slack events route', () => {
  it('refuses a request without a good, recent signature', async () => {
    const { post, env } = await world()
    expect(
      (await post({ type: 'url_verification', challenge: 'x' }, { sig: 'v0=00' })).status
    ).toBe(401)
    const stale = String(Math.floor(env.deps.clock.now().getTime() / 1000) - 600)
    expect((await post({ type: 'url_verification', challenge: 'x' }, { ts: stale })).status).toBe(
      401
    )
  })

  it('answers the URL check with its challenge', async () => {
    const { post } = await world()
    const res = await post({ type: 'url_verification', challenge: 'abc123' })
    expect(await res.json()).toEqual({ challenge: 'abc123' })
  })

  it('is not there without the Slack app: even a signed URL check gets the API’s sign-in refusal', async () => {
    const env = setup({})
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' })
    const ts = String(Math.floor(env.deps.clock.now().getTime() / 1000))
    const res = await env.app.request('/api/integrations/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': slackSignature(SECRET, ts, body),
      },
      body,
    })
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('abc123')
    expect(instanceMetadata(env.config).capabilities.slackUnfurls).toBe(false)
  })

  it('stays off while a secret holds Terraform’s placeholder', () => {
    const config = setup({}).config
    config.secrets.slackSigningSecret = SECRET
    config.secrets.slackBotToken = 'unset'
    expect(instanceMetadata(config).capabilities.slackUnfurls).toBe(false)
    config.secrets.slackBotToken = 'xoxb-test'
    expect(instanceMetadata(config).capabilities.slackUnfurls).toBe(true)
  })
})

describe('link previews', () => {
  it('gives the owner a card for their only-me site: its title, opening its review page, and its links', async () => {
    const { post, shared, slack } = await world()
    expect((await post(shared('U-ALICE', 'https://secret.fling.test/'))).status).toBe(200)
    expect(slack.calls).toHaveLength(1)
    expect(slack.calls[0]?.target).toEqual({ channel: 'C1', ts: '1700000000.000100' })
    const text = JSON.stringify(slack.calls[0]?.unfurls['https://secret.fling.test/'])
    expect(text).toContain('secret deck')
    expect(text).toContain('Only its owners can open it')
    // Review is the title's link and the first one; no link to the site's page in the app.
    expect(text).toContain(`*<${APP_ORIGIN}/review/secret|secret deck>*`)
    expect(text).toContain(
      `<${APP_ORIGIN}/review/secret|Review> · <https://secret.fling.test/|Open>`
    )
    expect(text).not.toContain(`${APP_ORIGIN}/sites/secret`)
  })

  it('gives a member who is not the author a card for a members-level site', async () => {
    const { post, shared, slack } = await world()
    await post(
      shared('U-BOB', 'https://team.fling.test/slides/2.html', `${APP_ORIGIN}/review/team`)
    )
    expect(Object.keys(slack.calls[0]?.unfurls ?? {})).toEqual([
      'https://team.fling.test/slides/2.html',
      `${APP_ORIGIN}/review/team`,
    ])
    // Everyone signed in can open it, as most sites: the card doesn't say so.
    const card = JSON.stringify(slack.calls[0]?.unfurls['https://team.fling.test/slides/2.html'])
    expect(card).toContain('team deck')
    expect(card).not.toContain('can open it')
    expect(card).toContain('Published')
  })

  /** The card each link got, as text. */
  const cardsOf = (slack: FakeSlack) =>
    Object.fromEntries(
      Object.entries(slack.calls[0]?.unfurls ?? {}).map(([url, card]) => [
        url,
        JSON.stringify(card),
      ])
    )

  it('gives a site the poster cannot open the neutral card, the same as a name nobody holds', async () => {
    const { post, shared, slack } = await world()
    await post(shared('U-BOB', 'https://secret.fling.test/', 'https://nothing-here.fling.test/'))
    const cards = cardsOf(slack)
    const secret = cards['https://secret.fling.test/'] ?? ''
    expect(secret).toContain('A site on Fling')
    expect(secret).not.toContain('secret deck')
    expect(secret).not.toContain('can open it')
    expect(cards['https://nothing-here.fling.test/']).toBe(
      secret
        .replaceAll('https://secret.fling.test/', 'https://nothing-here.fling.test/')
        .replaceAll('secret', 'nothing-here')
    )
  })

  it('gives a Slack account with no Fling user the neutral card', async () => {
    const { post, shared, slack } = await world()
    await post(shared('U-ROBOT', 'https://team.fling.test/'))
    await post(shared('U-UNKNOWN', 'https://team.fling.test/'))
    expect(slack.calls).toHaveLength(2)
    for (const call of slack.calls) {
      const card = JSON.stringify(call.unfurls['https://team.fling.test/'])
      expect(card).toContain('A site on Fling')
      expect(card).not.toContain('team deck')
    }
  })

  it('gives an archived site the neutral card, even for its owner', async () => {
    const { post, shared, slack, env, alice } = await world()
    await api(env, alice.key, 'POST', '/api/sites/team/archive')
    await post(shared('U-ALICE', 'https://team.fling.test/'))
    expect(cardsOf(slack)['https://team.fling.test/']).not.toContain('team deck')
  })

  it('gives a share link and a page that names no site the neutral card, without asking who posted', async () => {
    const { post, shared, slack } = await world()
    const share = 'https://s--abcdefabcdefabcdefabcdef.fling.test/'
    await post(shared('U-ALICE', share, `${APP_ORIGIN}/guide`))
    const cards = cardsOf(slack)
    expect(cards[share]).toContain('*<https://s--abcdefabcdefabcdefabcdef.fling.test/|Fling>*')
    expect(cards[`${APP_ORIGIN}/guide`]).toContain('Fling')
  })

  it('does no work on a retry', async () => {
    const { post, shared, slack } = await world()
    await post(shared('U-ALICE', 'https://team.fling.test/'), {
      headers: { 'x-slack-retry-num': '1' },
    })
    expect(slack.calls).toEqual([])
  })
})

describe('siteNameOf', () => {
  const deps = { config: setup({}).config }
  it('reads a site host, and the review and site pages on the app', () => {
    expect(siteNameOf(deps, 'https://deck.fling.test/a/b')).toBe('deck')
    expect(siteNameOf(deps, `${APP_ORIGIN}/review/deck`)).toBe('deck')
    expect(siteNameOf(deps, `${APP_ORIGIN}/sites/deck/`)).toBe('deck')
  })
  it('reads nothing else', () => {
    expect(siteNameOf(deps, 'https://s--abcdefabcdefabcdefabcdef.fling.test/')).toBeNull()
    expect(siteNameOf(deps, `${APP_ORIGIN}/guide`)).toBeNull()
    expect(siteNameOf(deps, 'https://deck.elsewhere.test/')).toBeNull()
    expect(siteNameOf(deps, 'not a url')).toBeNull()
  })
})

describe('SlackWebClient', () => {
  it('calls the global fetch as the Workers runtime requires, on nothing but itself', async () => {
    const real = globalThis.fetch
    // Workers throw "Illegal invocation" for a fetch called with any other `this`.
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(
        Response.json({ ok: true, user: { profile: { email: 'a@example.test' } } })
      )
    } as typeof fetch
    try {
      expect(await new SlackWebClient('xoxb-1').userEmail('U-1')).toBe('a@example.test')
    } finally {
      globalThis.fetch = real
    }
  })

  it('reads a person’s email and refuses a bot’s', async () => {
    const answers: Record<string, unknown> = {
      'U-1': { ok: true, user: { profile: { email: 'Alice@Example.test' } } },
      'U-2': { ok: true, user: { is_bot: true, profile: { email: 'bot@example.test' } } },
    }
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer xoxb-1')
      return Response.json(answers[new URL(url).searchParams.get('user') ?? ''])
    }) as typeof fetch
    const client = new SlackWebClient('xoxb-1', fetchImpl)
    expect(await client.userEmail('U-1')).toBe('alice@example.test')
    expect(await client.userEmail('U-2')).toBeNull()
  })
})
