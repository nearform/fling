/**
 * The end-to-end scenario: what a Fling instance must do, whatever platform it runs on. It talks
 * to `appOrigin` only as a user would: the real CLI (apps/cli, run from source) for deploys and site
 * commands, plain HTTP for the sites, the API and the remote MCP endpoint.
 *
 *   metadata → whoami → deploy v1 (`--access public`) → view → robots.txt → the version served
 *   (`/_fling-version`) → 404 / trailing-slash → deploy v2 (keeps its access) → view, and the
 *   version served follows → versions (who published) → rollback to v1 → open to
 *   members: anonymous redirect to sign-in, member view (with a site cookie) → share link (its answers send no Referer) → a new
 *   site with no `--access` (the instance's default; only you: the member is refused, the share
 *   link serves it; then open to members, the member sees it) → comments (owner and member; anonymous refused) → live room (two peers: pointers,
 *   comment changes) → admin (the users list; every site's listing, the owner's site included;
 *   the settings, secrets by name only; the owner's site read by key, changed only from the
 *   browser, audited; impersonating the owner: their sites, no API key, stop) → audience (restricted to the member:
 *   they get in through the site pass, an outsider finds nothing, the share link still serves) →
 *   group (the member makes one the owner can see and use but not change; the owner names it in
 *   the audience; the outsider, once in it, gets in, and once out is refused; deleting it leaves
 *   the site to its owner) → owners and publishers (the member, made a publisher, deploys, lists
 *   the site as its publisher, is refused its access and owners and rolls back; the last person
 *   owner can't be removed; the member is made an owner and taken out; a group's member publishes
 *   through the group) → invitations (where on, with the dev mailbox: an outsider shared with
 *   signs in by the emailed link, sees the site through the pass and comments, finds members-only
 *   sites missing and may not deploy, mint a key or make a group; revoked, refused; an admin's
 *   member invitation signs another outsider in, who deploys, and once revoked finds their site
 *   cookie sent to sign in by the revocation list) → thumbnails (the owner keeps a PNG of the
 *   current version; the publisher replaces it and reads it; an outsider is refused until the
 *   audience names them; another version is a 409) → conditional-write race (concurrent
 *   first deploys of one name) → MCP publish → clean up (every site it made is removed).
 *
 * Notifications ride along where their causes happen: the settings answer wherever the instance
 * has email, and where the dev drain exists (`POST /dev/notify/drain`, local runs only) the
 * scenario drains the outbox and reads, as each recipient, what was sent to them: the comment and
 * reply (a burst folded into one email), the share, the group add and the group share, a new
 * publisher and owner (directly and through a group), nothing for the actor, and nothing after an
 * opt-out.
 *
 * Content checks poll (up to `propagationMs`): on a real deployment a changed route can take a while
 * to reach the edge location the check lands on. New sites must not need it: the CLI's readiness
 * wait covers them, and the scenario fails if a new site is not routed when the CLI says it is.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import {
  defaultAccessOf,
  type InstanceMetadata,
  InstanceMetadataSchema,
  instanceMetadataUrl,
  type LiveServerMessage,
} from '@fling/shared'
import { runCli } from './cli.ts'
import { cookiePairs, type Session } from './sign-in.ts'

export interface ScenarioOptions {
  appOrigin: string
  session: Session
  /**
   * A second user of the instance, for what a member may do to someone else's site (comments);
   * without one those checks are skipped.
   */
  member?: Session
  /**
   * An admin of the instance (ADMIN_EMAILS): with a browser session (`cookie`, local runs) the
   * users list and an impersonation of `session`; with only an API key (smoke tests) the list,
   * and impersonation refused. Without one, skipped.
   */
  admin?: Session
  /**
   * A user outside a restricted site's audience, who isn't an admin. Without one, the audience
   * checks find the admin reading the site anyway (an admin reads any site) and the group checks
   * add the admin to the group; without either, those checks are skipped.
   */
  outsider?: Session
  /** how long a changed route may take to show (default 5 s locally; smoke tests pass more) */
  propagationMs?: number
  log?: (line: string) => void
}

class ScenarioError extends Error {}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ScenarioError(message)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Fetched {
  status: number
  location: string | null
  text: string
  headers: Headers
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { 'cache-control': 'no-cache', ...headers },
  })
  return {
    status: res.status,
    location: res.headers.get('location'),
    text: await res.text(),
    headers: res.headers,
  }
}

/**
 * As a browser would: follow redirects from `url`, sending each host the cookies it holds (`jar`:
 * host → `a=1; b=2`, starting with the ones given) and keeping those it sets. Where it ended up.
 */
async function browse(
  url: string,
  jar: Record<string, string>
): Promise<Fetched & { url: string; hops: string[] }> {
  const hops: string[] = []
  let at = url
  for (let i = 0; i < 10; i++) {
    const host = new URL(at).host
    const res = await get(at, jar[host] ? { cookie: jar[host] } : {})
    const held = new Map(
      (jar[host] ?? '')
        .split(/;\s*/)
        .filter(Boolean)
        .map(c => [c.split('=')[0] as string, c] as const)
    )
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0] as string
      held.set(pair.split('=')[0] as string, pair)
    }
    jar[host] = [...held.values()].join('; ')
    if (res.status < 300 || res.status >= 400 || !res.location) return { ...res, url: at, hops }
    hops.push(`${res.status} ${at}`)
    at = new URL(res.location, at).toString()
  }
  throw new ScenarioError(`too many redirects from ${url}: ${hops.join(' → ')}`)
}

/**
 * Someone signed in (`session`, their app cookie; `siteCookie`, their `fling_site`) whom a
 * restricted site, or a members-level one to a guest, refuses: a browser goes
 * from `siteUrl` through sign-in and the site's `/_fling-pass` back to `siteUrl`, which answers
 * 404 with the sites' 404 page, exactly as a site that does not exist.
 */
async function refusedAt(
  siteUrl: string,
  appOrigin: string,
  session: string,
  who: string,
  siteCookie?: string
) {
  const jar: Record<string, string> = { [new URL(appOrigin).host]: session }
  // The browser's `fling_site`, which the sites host sees (a guest's goes through the pass).
  if (siteCookie) jar[new URL(siteUrl).host] = siteCookie
  const end = await browse(siteUrl, jar)
  const origin = new URL(siteUrl).origin
  const route = `${end.hops.join(' → ')} → ${end.status} ${end.url}`
  check(
    end.hops.some(h => h.includes(`${appOrigin}/auth/login?`)) &&
      end.hops.some(h => h.includes(`${origin}/_fling-pass?t=`)),
    `${who}: not refused through sign-in and the site pass path: ${route}`
  )
  const unknown = await get(siteUrl.replace(/\/\/([^.]+)\./, '//$1-nobody.'))
  check(
    end.url === new URL(siteUrl).href &&
      end.status === 404 &&
      unknown.status === 404 &&
      end.text === unknown.text,
    `${who}: not the sites' 404 page at the site's address (${route}; unknown site ${unknown.status})`
  )
}

/** Poll until `ok`, or fail with the last response. */
async function eventually(
  what: string,
  url: string,
  ok: (r: Fetched) => boolean,
  opts: { timeoutMs: number; headers?: Record<string, string> }
): Promise<Fetched> {
  const start = Date.now()
  let last: Fetched | undefined
  for (;;) {
    last = await get(url, opts.headers)
    if (ok(last)) return last
    if (Date.now() - start > opts.timeoutMs) break
    await sleep(1000)
  }
  throw new ScenarioError(
    `${what}: ${url} answered ${last.status}${last.location ? ` → ${last.location}` : ''}: ${last.text.slice(0, 200)}`
  )
}

interface CliSite {
  name: string
  url: string
  visibility: string
  access?: string
  shareUrl?: string | null
  currentVersionId?: string | null
}

function siteDir(root: string, label: string, files: Record<string, string>) {
  const dir = join(root, label)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const page = (title: string, marker: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${marker}</h1></body></html>\n`

/** A remote MCP tool call as `session`: the tool's result. */
async function mcpTool(
  appOrigin: string,
  session: Session,
  tool: string,
  args: Record<string, unknown>
): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> } | undefined> {
  const res = await fetch(`${appOrigin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  })
  check(res.status === 200, `MCP ${tool}: ${res.status} ${await res.clone().text()}`)
  return ((await res.json()) as { result?: Awaited<ReturnType<typeof mcpTool>> }).result
}

interface SentJson {
  id: string
  channel: string
  eventKeys: string[]
  subject: string
  providerId: string | null
  sentAt: string
}

interface NotificationSettingsJson {
  channels: string[]
  muted: boolean
  cells: Record<string, Record<string, string>>
}

/**
 * What each person was sent, on an instance with the dev drain: `take` drains the outbox now
 * (`POST /dev/notify/drain`, which also delivers what is due in the next hour, so nothing waits
 * for a tick or a fold) and returns the messages `GET /api/me/notifications/sent` lists for them
 * that it has not returned before.
 */
interface Mailbox {
  take(session: Session): Promise<SentJson[]>
}

/** The mailbox, or null where there is no dev drain (a deployed instance). */
async function devMailbox(appOrigin: string, sessions: Session[]): Promise<Mailbox | null> {
  const drain = async () => {
    const res = await fetch(`${appOrigin}/dev/notify/drain`, { method: 'POST' })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
      return null
    }
    return (await res.json()) as { sent?: unknown; complete?: boolean }
  }
  const first = await drain()
  if (typeof first?.sent !== 'number') return null
  const sent = async (session: Session) => {
    const res = await fetch(`${appOrigin}/api/me/notifications/sent`, {
      headers: { authorization: `Bearer ${session.apiKey}`, accept: 'application/json' },
    })
    check(res.status === 200, `GET /api/me/notifications/sent as ${session.email}: ${res.status}`)
    return ((await res.json()) as { sent: SentJson[] }).sent
  }
  const seen = new Set<string>()
  for (const session of sessions) for (const m of await sent(session)) seen.add(m.id)
  return {
    async take(session) {
      // A drain stops early when the background tick holds a batch or moved the cursor: again.
      for (let i = 0; i < 10; i++) {
        const result = await drain()
        check(result, 'POST /dev/notify/drain stopped answering')
        if (result.complete) break
        await sleep(500)
      }
      const fresh = (await sent(session)).filter(m => !seen.has(m.id))
      for (const m of fresh) seen.add(m.id)
      return fresh
    },
  }
}

/** One email, about exactly these events (folded, in any order), from this instance. */
function oneEmail(got: SentJson[], keys: string[], instance: string, who: string) {
  const [m] = got
  check(
    got.length === 1 &&
      m?.channel === 'email' &&
      m.providerId &&
      m.eventKeys.length === keys.length &&
      keys.every(k => m.eventKeys.includes(k)) &&
      m.subject.startsWith(`${instance}: `),
    `${who}: want one email about ${keys.join(' + ')}, got ${JSON.stringify(got)}`
  )
}

function noEmail(got: SentJson[], who: string) {
  check(got.length === 0, `${who}: want no email, got ${JSON.stringify(got)}`)
}

export async function runScenario(opts: ScenarioOptions): Promise<void> {
  const log = opts.log ?? (line => console.log(line))
  const step = (line: string) => log(`  ✓ ${line}`)
  const propagationMs = opts.propagationMs ?? 5_000
  const appOrigin = opts.appOrigin.replace(/\/+$/, '')
  const nonce = randomBytes(4).toString('hex')
  const name = `e2e-${nonce}`
  const raceName = `e2e-${nonce}-race`
  const mcpName = `e2e-${nonce}-mcp`
  const mineName = `e2e-${nonce}-mine`
  const work = mkdtempSync(join(tmpdir(), 'fling-e2e-'))
  const fling = (...args: string[]) =>
    runCli(args, {
      serverUrl: appOrigin,
      apiKey: opts.session.apiKey,
      configDir: join(work, 'cli'),
    })
  /** The CLI as someone else, with a config dir of their own. */
  const flingAs =
    (session: Session) =>
    (...args: string[]) =>
      runCli(args, {
        serverUrl: appOrigin,
        apiKey: session.apiKey,
        configDir: join(
          work,
          `cli-${createHash('sha256').update(session.email).digest('hex').slice(0, 8)}`
        ),
      })
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${appOrigin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.session.apiKey}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const made: string[] = []

  try {
    // Metadata: the instance describes itself, for this origin.
    const metaRes = await fetch(instanceMetadataUrl(appOrigin))
    check(metaRes.ok, `${instanceMetadataUrl(appOrigin)} answered ${metaRes.status}`)
    const meta: InstanceMetadata = InstanceMetadataSchema.parse(await metaRes.json())
    check(
      meta.appOrigin === appOrigin,
      `metadata appOrigin ${meta.appOrigin}, expected ${appOrigin}`
    )
    step(`instance "${meta.name}": sites at ${meta.siteScheme}://<name>.${meta.sitesDomain}`)
    // The Claude Desktop extension, where the Get started page links to it: a zip (an mcpb) or,
    // where none was built (local runs), a 404; never the web UI's index.html under its name.
    const mcpb = await fetch(`${appOrigin}/downloads/fling.mcpb`, { redirect: 'manual' })
    const mcpbBytes = new Uint8Array(await mcpb.arrayBuffer())
    check(
      mcpb.status === 404 ||
        (mcpb.status === 200 && mcpbBytes[0] === 0x50 && mcpbBytes[1] === 0x4b),
      `downloads/fling.mcpb: ${mcpb.status} ${mcpb.headers.get('content-type')}, not a zip`
    )
    step(`Claude Desktop extension: ${mcpb.status === 200 ? 'a zip' : 'none built (404)'}`)

    const who = (await fling('whoami')) as { email?: string }
    check(who.email === opts.session.email, `whoami: ${JSON.stringify(who)}`)
    step(`signed in as ${who.email}`)

    // Notifications: where the instance has email, the settings answer (nothing is sent here).
    // Where the dev drain exists too, the steps below check what each person is sent.
    let mail: Mailbox | null = null
    if (meta.capabilities.email === true) {
      check(meta.capabilities.notifications === true, 'email without the notifications capability')
      const settings = await api('GET', '/api/me/notifications')
      const body = (await settings.json()) as NotificationSettingsJson
      check(
        settings.status === 200 && body.channels.includes('email') && body.cells,
        `GET /api/me/notifications: ${settings.status} ${JSON.stringify(body)}`
      )
      const people = [opts.session, opts.member, opts.admin, opts.outsider].filter(
        (s): s is Session => s !== undefined
      )
      mail = await devMailbox(appOrigin, people)
      step(
        `notifications: settings answer; ${mail ? 'the dev drain is here, so mail is checked' : 'no dev drain, so nothing is sent or checked'}`
      )
    } else {
      step('notifications: no email on this instance (skipped)')
    }

    // Deploy (the CLI: manifest, presigned uploads, finalize, readiness wait) and view.
    const v1 = siteDir(work, 'v1', {
      'index.html': page('v1', `v1 ${nonce}`),
      'docs/index.html': page('docs', `docs ${nonce}`),
      'style.css': 'h1 { color: rebeccapurple }\n',
    })
    // Access levels: a new site says who can open it (`--access`); older instances, `--public`.
    const levels = meta.capabilities.accessLevels === true
    const first = (await fling(
      'deploy',
      v1,
      '--name',
      name,
      ...(levels ? ['--access', 'public'] : ['--public'])
    )) as {
      status: string
      ready: boolean
      site: CliSite
    }
    made.push(name)
    check(first.status === 'live', `first deploy: ${JSON.stringify(first)}`)
    check(first.ready, 'the CLI gave up waiting for the new site to be routed')
    const siteUrl = first.site.url
    const v1Id = first.site.currentVersionId
    check(v1Id, 'deploy returned no currentVersionId')
    const home = await get(siteUrl)
    check(
      home.status === 200 && home.text.includes(`v1 ${nonce}`),
      `view ${siteUrl}: ${home.status}`
    )
    check(
      (home.headers.get('content-type') ?? '').startsWith('text/html'),
      `content-type ${home.headers.get('content-type')}`
    )
    step(`deployed ${name} and viewed it at ${siteUrl}`)
    // Review mode iframes sites from the app origin: nothing on the way may forbid framing them.
    const csp = home.headers.get('content-security-policy') ?? ''
    check(
      !home.headers.get('x-frame-options') && !/frame-ancestors/i.test(csp),
      `site responses refuse framing: x-frame-options ${home.headers.get('x-frame-options')}, csp ${csp}`
    )
    // The review shell review mode frames, on the site's own origin: served, filled in, frameable.
    const shell = await get(`${siteUrl}_fling/review.html?path=%2F`)
    const shellCsp = shell.headers.get('content-security-policy') ?? ''
    check(
      shell.status === 200 &&
        /text\/html/.test(shell.headers.get('content-type') ?? '') &&
        shell.text.includes(`content="${meta.appOrigin}"`) &&
        !shell.headers.get('x-frame-options') &&
        !/frame-ancestors/i.test(shellCsp),
      `review shell: ${shell.status} ${shell.headers.get('content-type')}, x-frame-options ${shell.headers.get('x-frame-options')}, csp ${shellCsp}`
    )
    step('review shell served on the site host, frameable')
    // Sites are not indexed: every sites host's robots.txt is Fling's.
    const robots = await get(`${siteUrl}robots.txt`)
    check(
      robots.status === 200 && /^Disallow: \/$/m.test(robots.text),
      `robots.txt: ${robots.status} ${robots.text.slice(0, 80)}`
    )
    step('robots.txt on the site host disallows everything')
    // Which version the host serves, as the preview shell asks before it draws a thumbnail: an
    // answer the edge makes itself, so its header reaches the browser on every platform.
    const servedNow = await get(`${siteUrl}_fling-version`)
    check(
      servedNow.status === 204 &&
        servedNow.headers.get('x-fling-version') === v1Id &&
        servedNow.headers.get('cache-control') === 'no-store',
      `/_fling-version: ${servedNow.status}, x-fling-version ${servedNow.headers.get('x-fling-version')} (current ${v1Id}), cache-control ${servedNow.headers.get('cache-control')}`
    )
    step('/_fling-version says the current version')

    const css = await get(`${siteUrl}style.css`)
    check(css.status === 200 && css.text.includes('rebeccapurple'), `style.css: ${css.status}`)
    const docs = await get(`${siteUrl}docs`)
    check(
      docs.status === 301 && docs.location === '/docs/',
      `/docs: ${docs.status} ${docs.location}`
    )
    const missing = await get(`${siteUrl}nope.html`)
    check(missing.status === 404, `missing file: ${missing.status}`)
    const dotfile = await get(`${siteUrl}.env`)
    check(dotfile.status === 404, `dotfile: ${dotfile.status}`)
    step('files, trailing-slash redirect, 404 for missing files and dotfiles')

    // A second version, then roll back to the first.
    const v2 = siteDir(work, 'v2', { 'index.html': page('v2', `v2 ${nonce}`) })
    // A re-deploy keeps the site's access: v2 is served to anyone, as v1 was.
    const second = (await fling('deploy', v2, '--name', name, ...(levels ? [] : ['--public']))) as {
      status: string
      site: CliSite
    }
    check(second.status === 'live', `second deploy: ${JSON.stringify(second)}`)
    await eventually('v2 served', siteUrl, r => r.text.includes(`v2 ${nonce}`), {
      timeoutMs: propagationMs,
    })
    const v2Id = second.site.currentVersionId
    await eventually(
      '/_fling-version says v2',
      `${siteUrl}_fling-version`,
      r => r.status === 204 && !!v2Id && r.headers.get('x-fling-version') === v2Id,
      { timeoutMs: propagationMs }
    )
    step('deployed v2, and /_fling-version says so')

    const versions = (await fling('versions', name)) as {
      versions: { id: string; publishedBy?: string }[]
    }
    check(
      versions.versions.length === 2 &&
        versions.versions.every(v => v.publishedBy === opts.session.email),
      `versions: ${JSON.stringify(versions)}`
    )
    step('versions record who published them')
    await fling('rollback', name, v1Id)
    await eventually('rollback served', siteUrl, r => r.text.includes(`v1 ${nonce}`), {
      timeoutMs: propagationMs,
    })
    step('rolled back to v1')

    // Private: anonymous visitors are sent to sign in; members (with the site cookie) see it.
    if (levels) await fling('access', name, '--members')
    else await fling('visibility', name, 'private')
    const loginPrefix = `${appOrigin}/auth/login?return=`
    const redirect = await eventually(
      'private redirect',
      `${siteUrl}docs/?q=1`,
      r => r.status === 302 && (r.location ?? '').startsWith(loginPrefix),
      { timeoutMs: propagationMs }
    )
    const back = decodeURIComponent((redirect.location ?? '').slice(loginPrefix.length))
    check(back === `${siteUrl}docs/?q=1`, `sign-in return URL ${back}`)
    if (opts.session.siteCookie) {
      const member = await get(siteUrl, { cookie: opts.session.siteCookie })
      check(
        member.status === 200 && member.text.includes(`v1 ${nonce}`),
        `member view: ${member.status}`
      )
      step('private: anonymous → sign-in redirect, member with the site cookie → served')
    } else {
      step('private: anonymous → sign-in redirect (no site cookie with this sign-in)')
    }

    // A share link serves the private site to anyone.
    const shared = (await fling('share', name)) as { shareUrl?: string; ready?: boolean }
    check(shared.shareUrl, `share: ${JSON.stringify(shared)}`)
    const viaShare = await get(shared.shareUrl)
    check(
      viaShare.status === 200 && viaShare.text.includes(`v1 ${nonce}`),
      `share link ${shared.shareUrl}: ${viaShare.status}`
    )
    step(`share link ${shared.shareUrl} serves it without signing in`)
    // A share host's address is its secret: what the edge answers there sends no Referer on, and
    // a site host's keeps the browser's default. Both say noindex.
    const shareAnswer = await get(new URL('docs', shared.shareUrl).href)
    check(
      shareAnswer.status === 301 &&
        shareAnswer.headers.get('referrer-policy') === 'no-referrer' &&
        shareAnswer.headers.get('x-robots-tag') === 'noindex',
      `share host ${shareAnswer.status}: referrer-policy ${shareAnswer.headers.get('referrer-policy')}, x-robots-tag ${shareAnswer.headers.get('x-robots-tag')}`
    )
    check(
      !redirect.headers.get('referrer-policy') &&
        redirect.headers.get('x-robots-tag') === 'noindex',
      `site host redirect: referrer-policy ${redirect.headers.get('referrer-policy')}, x-robots-tag ${redirect.headers.get('x-robots-tag')}`
    )
    step('share host answers say no-referrer, site host answers keep the default; both noindex')

    // A new site with no access asked for gets the instance's default: only its owner, unless the
    // instance opens new sites to everyone signed in.
    if (levels) {
      made.push(mineName)
      await defaultAccessStep({
        appOrigin,
        meta,
        name: mineName,
        work,
        nonce,
        fling,
        opts,
        step,
        propagationMs,
      })
    } else {
      step('access levels: not on this instance (skipped)')
    }

    // Comments (review mode's data): the owner through the CLI, a member through the API, the
    // remote MCP tools; anonymous callers refused. Only where the instance has them.
    if (meta.capabilities.comments === true) {
      await commentsStep({ appOrigin, name, v1Id, fling, opts, step, mail, instance: meta.name })
    } else {
      step('comments: turned off on this instance (skipped)')
    }

    // Live rooms (review mode's realtime): two people in the site's room. Only where the instance
    // has them.
    if (meta.capabilities.live === true) {
      await liveStep({ appOrigin, name, opts, step })
    } else {
      step('live rooms: turned off on this instance (skipped)')
    }

    // Admins: the users list, and acting as the owner (who isn't an admin) through impersonation.
    if (opts.admin) {
      await adminStep({ appOrigin, name, opts, step })
    } else {
      step('admin: no admin session (skipped)')
    }

    // Audiences: the owner limits the private site to the member; the site pass lets them in.
    if (meta.capabilities.audiences === true) {
      await audienceStep({
        appOrigin,
        name,
        siteUrl,
        shareUrl: shared.shareUrl,
        marker: `v1 ${nonce}`,
        comments: meta.capabilities.comments === true,
        fling,
        opts,
        step,
        propagationMs,
        mail,
        instance: meta.name,
      })
    } else {
      step('audiences: not on this instance (skipped)')
    }

    // Groups: a list of people the member owns, used by the owner in the site's audience.
    if (meta.capabilities.audiences === true && meta.capabilities.groups === true) {
      await groupStep({
        appOrigin,
        name,
        nonce,
        siteUrl,
        comments: meta.capabilities.comments === true,
        fling,
        flingAs,
        opts,
        step,
        mail,
        instance: meta.name,
      })
    } else {
      step('groups: not on this instance (skipped)')
    }

    // Owners and publishers: the member publishes the owner's site, then co-owns it for a while.
    if (meta.capabilities.siteRoles === true) {
      await rolesStep({
        appOrigin,
        name,
        nonce,
        work,
        groups: meta.capabilities.groups === true,
        fling,
        flingAs,
        opts,
        step,
        mail,
        instance: meta.name,
      })
    } else {
      step('owners and publishers: not on this instance (skipped)')
    }

    // Path publish: a publisher replaces one folder of a site and the rest stays served.
    if (meta.capabilities.pathPublish === true) {
      await pathPublishStep({
        name: `e2e-${nonce}-path`,
        nonce,
        work,
        levels,
        roles: meta.capabilities.siteRoles === true,
        fling,
        flingAs,
        made,
        opts,
        step,
        propagationMs,
      })
    } else {
      step('path publish: not on this instance (skipped)')
    }

    // Thumbnails: owners and publishers keep a PNG of the home page; whoever views the site reads it.
    if (meta.capabilities.thumbnails === true) {
      await thumbnailStep({
        appOrigin,
        name: `e2e-${nonce}-thumb`,
        work: work,
        nonce,
        levels,
        roles: meta.capabilities.siteRoles === true,
        audiences: meta.capabilities.audiences === true,
        fling,
        made,
        opts,
        step,
      })
    } else {
      step('thumbnails: not on this instance (skipped)')
    }

    // Invitations: an outsider shared with signs in by the emailed link and reviews as a guest;
    // an admin revokes them and invites another outsider as a member. Only where the instance has
    // them and the dev mailbox (`/dev/mail`) shows the links, with an admin's browser session.
    if (meta.capabilities.invites === true && mail && opts.admin?.cookie) {
      await invitationStep({
        appOrigin,
        nonce,
        work,
        fling,
        flingAs,
        made,
        opts,
        step,
        comments: meta.capabilities.comments === true,
        propagationMs,
      })
    } else {
      step('invitations: off, or no dev mailbox or admin session (skipped)')
    }

    // Conditional writes under a race: concurrent first deploys of one fresh name. Each creates
    // the name claim, the site and its index item in one conditional transaction; exactly one
    // wins, the others' conditions fail (rolled back) and they find the winner's site.
    const content = page('race', `race ${nonce}`)
    const manifest = {
      files: [
        {
          path: 'index.html',
          sha256: createHash('sha256').update(content).digest('hex'),
          size: Buffer.byteLength(content),
          contentType: 'text/html; charset=utf-8',
        },
      ],
    }
    made.push(raceName)
    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        api('POST', `/api/sites/${raceName}/deploys`, { manifest, visibility: 'public' })
      )
    )
    const statuses = raced.map(r => r.status)
    check(
      statuses.every(s => s === 200 || s === 201),
      `concurrent deploys: ${statuses.join(', ')}`
    )
    const versionIds = new Set(
      await Promise.all(raced.map(async r => ((await r.json()) as { versionId: string }).versionId))
    )
    check(versionIds.size === 1, `concurrent deploys disagree: ${[...versionIds].join(', ')}`)
    // Finish it with the CLI (same content, so the same version): live, and listed once.
    const raceDir = siteDir(work, 'race', { 'index.html': content })
    const raceDeploy = (await fling('deploy', raceDir, '--name', raceName, '--public')) as {
      site: CliSite
    }
    const viaRace = await get(raceDeploy.site.url)
    check(viaRace.text.includes(`race ${nonce}`), `view ${raceDeploy.site.url}: ${viaRace.status}`)
    const listed = (await (await api('GET', '/api/sites')).json()) as {
      sites: { name: string }[]
    }
    const matches = listed.sites.filter(s => s.name === raceName)
    check(matches.length === 1, `${raceName} is listed ${matches.length} times`)
    step('conditional writes: 4 concurrent first deploys of one name → one site')

    // `fling ls` lists the last updated first; `--sort name` lists A–Z.
    const lsSites = async (...args: string[]) =>
      ((await fling('ls', ...args)) as { sites: { name: string; updatedAt: string }[] }).sites
    const byUpdated = await lsSites()
    check(
      byUpdated.every((s, i) => i === 0 || byUpdated[i - 1].updatedAt >= s.updatedAt),
      `fling ls is not last updated first: ${byUpdated.map(s => s.name).join(', ')}`
    )
    const byName = (await lsSites('--sort', 'name')).map(s => s.name)
    check(
      byName.every((n, i) => i === 0 || byName[i - 1] <= n),
      `fling ls --sort name is not A–Z: ${byName.join(', ')}`
    )
    step('fling ls: last updated first, --sort name A–Z')

    // The remote MCP connector publishes inline content.
    const mcp = await fetch(`${appOrigin}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.session.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'fling_publish',
          arguments: {
            name: mcpName,
            ...(levels ? { access: 'public' } : { public: true }),
            files: [{ path: 'index.html', content: page('mcp', `mcp ${nonce}`) }],
          },
        },
      }),
    })
    made.push(mcpName)
    check(mcp.status === 200, `MCP publish: ${mcp.status} ${await mcp.clone().text()}`)
    const result = (
      (await mcp.json()) as {
        result?: { isError?: boolean; structuredContent?: { url?: string; status?: string } }
      }
    ).result
    check(
      result && !result.isError && result.structuredContent?.url,
      `MCP publish: ${JSON.stringify(result)}`
    )
    const mcpUrl = result.structuredContent.url
    const viaMcp = await get(mcpUrl)
    check(
      viaMcp.status === 200 && viaMcp.text.includes(`mcp ${nonce}`),
      `view ${mcpUrl}: ${viaMcp.status}`
    )
    step(`MCP publish → ${mcpUrl}`)
  } finally {
    for (const site of made) {
      await fling('rm', site, '--yes').catch(err => log(`  ! could not remove ${site}: ${err}`))
    }
    rmSync(work, { recursive: true, force: true })
  }
  step(`removed ${made.join(', ')}`)
}

interface CommentJson {
  id: string
  parentId: string | null
  path: string
  versionId: string | null
  resolvedAt: string | null
  canDelete: boolean
  author: { kind: string; email?: string }
}

async function commentsStep(ctx: {
  appOrigin: string
  name: string
  v1Id: string
  fling: (...args: string[]) => Promise<unknown>
  opts: ScenarioOptions
  step: (line: string) => void
  mail: Mailbox | null
  instance: string
}) {
  const { appOrigin, name, v1Id, fling, opts, step, mail } = ctx
  const call = (session: Session | null, method: string, path: string, body?: unknown) =>
    fetch(`${appOrigin}/api/sites/${name}/comments${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(session ? { authorization: `Bearer ${session.apiKey}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  const thread = (await fling(
    'comment',
    name,
    'The heading is too big',
    '--path',
    'docs/index.html'
  )) as CommentJson
  check(
    thread.path === '/docs/' && thread.versionId === v1Id && thread.parentId === null,
    `fling comment: ${JSON.stringify(thread)}`
  )
  step(`comment on ${name} /docs/ (on version ${v1Id})`)

  const anonymous = await call(null, 'GET', '')
  check(anonymous.status === 401, `anonymous comments list: ${anonymous.status}`)

  // A thread pinned to text selected in the page keeps its area and quote.
  const anchor = { x: 10, y: 20, selector: 'h1', ex: 0, ey: 0, ew: 80, eh: 100, quote: 'Docs' }
  const pinned = await call(opts.session, 'POST', '', { body: 'Rename', path: '/docs/', anchor })
  check(pinned.status === 201, `comment pinned to text: ${pinned.status}`)
  const pinnedId = ((await pinned.json()) as CommentJson).id
  const reread = (await (await call(opts.session, 'GET', '?path=/docs/')).json()) as {
    comments: (CommentJson & { anchor: unknown })[]
  }
  const stored = reread.comments.find(c => c.id === pinnedId)?.anchor
  const sorted = (o: unknown) => JSON.stringify(Object.entries(o ?? {}).sort())
  check(sorted(stored) === sorted(anchor), `pinned anchor: ${JSON.stringify(stored)}`)
  const unpinned = await call(opts.session, 'DELETE', `/${pinnedId}`)
  check(unpinned.status === 204, `deleting the pinned comment: ${unpinned.status}`)
  step('a thread pinned to selected text keeps its quote and area')

  let replyId: string | null = null
  if (opts.member) {
    const listed = await call(opts.member, 'GET', '?path=/docs/')
    check(listed.status === 200, `member comments list: ${listed.status}`)
    const view = (await listed.json()) as {
      comments: CommentJson[]
      can: { create: boolean; resolve: boolean; deleteAny: boolean }
    }
    check(
      view.comments.length === 1 &&
        view.comments[0]?.id === thread.id &&
        !view.comments[0]?.canDelete,
      `member's view: ${JSON.stringify(view.comments)}`
    )
    check(
      view.can.create && view.can.resolve && !view.can.deleteAny,
      `member may: ${JSON.stringify(view.can)}`
    )
    const replied = await call(opts.member, 'POST', '', { body: 'Agreed', parentId: thread.id })
    check(replied.status === 201, `member reply: ${replied.status}`)
    const reply = (await replied.json()) as CommentJson
    replyId = reply.id
    check(
      reply.author.email === opts.member.email && reply.path === '/docs/',
      `member reply: ${JSON.stringify(reply)}`
    )
    const refused = await call(opts.member, 'DELETE', `/${thread.id}`)
    check(refused.status === 403, `member deleting the owner's comment: ${refused.status}`)
    step("member: reads, replies, may not delete the owner's comment; anonymous: 401")

    if (mail) {
      // A burst: the member's reply above and two threads of theirs fold into one email to the
      // owner; the owner's reply in the member's thread reaches the member. Neither hears of
      // their own comments, and the owner of a thread they replied in gets the reply only.
      const threads: string[] = []
      for (const body of ['The footer is cut off', 'Typo in the second paragraph']) {
        const made = await call(opts.member, 'POST', '', { body, path: '/docs/' })
        check(made.status === 201, `member starts a thread: ${made.status}`)
        threads.push(((await made.json()) as CommentJson).id)
      }
      const answered = await call(opts.session, 'POST', '', {
        body: 'Fixed',
        parentId: threads[0],
      })
      check(answered.status === 201, `owner replies in the member's thread: ${answered.status}`)
      oneEmail(
        await mail.take(opts.session),
        ['comment.reply', 'comment.created'],
        ctx.instance,
        'owner, after a reply and two threads'
      )
      oneEmail(await mail.take(opts.member), ['comment.reply'], ctx.instance, 'member')
      for (const id of threads) {
        const gone = await call(opts.session, 'DELETE', `/${id}`)
        check(gone.status === 204, `owner deletes the member's thread: ${gone.status}`)
      }
      step(
        "mail: a reply and two new threads → one email to the owner; a reply in the member's thread → one to the member; none to the actors"
      )
    }
  } else {
    step('anonymous: 401 (no second user, so no member checks)')
  }

  await fling('resolve', name, thread.id)
  const all = (await fling('comments', name, '--all')) as { comments: CommentJson[] }
  const resolved = all.comments.find(c => c.id === thread.id)
  check(resolved?.resolvedAt, `resolved thread: ${JSON.stringify(resolved)}`)
  check(
    all.comments.length === (replyId ? 2 : 1),
    `comments after the reply: ${all.comments.length}`
  )

  // The remote MCP connector has the tools on this instance too.
  const mcp = await fetch(`${appOrigin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.session.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fling_comments_list', arguments: { name, includeResolved: true } },
    }),
  })
  const listed = (
    (await mcp.json()) as {
      result?: { isError?: boolean; structuredContent?: { comments?: unknown[] } }
    }
  ).result
  check(
    listed && !listed.isError && listed.structuredContent?.comments?.length === all.comments.length,
    `MCP fling_comments_list: ${JSON.stringify(listed)}`
  )

  await fling('uncomment', name, thread.id, '--yes')
  const after = (await fling('comments', name, '--all')) as { comments: CommentJson[] }
  check(after.comments.length === 0, `after deleting the thread: ${JSON.stringify(after.comments)}`)
  step('resolved (CLI), listed (CLI and MCP), deleted with its reply (CLI)')
}

/** A live room socket that keeps what it hears, for the scenario to wait on. */
interface LiveClient {
  heard: LiveServerMessage[]
  send(message: object): void
  /** the first message of `type` not taken yet, waiting for one (fails after a while) */
  next<K extends LiveServerMessage['type']>(
    type: K
  ): Promise<Extract<LiveServerMessage, { type: K }>>
  close(): void
}

async function liveClient(appOrigin: string, name: string, session: Session): Promise<LiveClient> {
  const res = await fetch(`${appOrigin}/api/sites/${name}/live`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.apiKey}`, accept: 'application/json' },
  })
  check(res.status === 200, `live ticket for ${session.email}: ${res.status}`)
  const { url, ticket } = (await res.json()) as { url: string; ticket: string }
  const ws = new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`)
  const heard: LiveClient['heard'] = []
  let wake: () => void = () => {}
  ws.addEventListener('message', e => {
    heard.push(JSON.parse(String(e.data)))
    wake()
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new ScenarioError(`live socket ${url} failed`)))
  })
  const taken = new Set<number>()
  return {
    heard,
    send: m => ws.send(JSON.stringify(m)),
    async next(type: LiveServerMessage['type']) {
      const deadline = Date.now() + 10_000
      for (;;) {
        const i = heard.findIndex((m, n) => !taken.has(n) && m.type === type)
        if (i >= 0) {
          taken.add(i)
          return heard[i] as never
        }
        check(
          Date.now() < deadline,
          `live: no ${type} for ${session.email}: ${JSON.stringify(heard)}`
        )
        await new Promise<void>(r => {
          wake = r
          setTimeout(r, 250)
        })
      }
    },
    close: () => ws.close(1000),
  }
}

async function liveStep(ctx: {
  appOrigin: string
  name: string
  opts: ScenarioOptions
  step: (line: string) => void
}) {
  const { appOrigin, name, opts, step } = ctx
  // Without a second user, the owner in two tabs: still two peers.
  const other = opts.member ?? opts.session
  const anonymous = await fetch(`${appOrigin}/api/sites/${name}/live`, { method: 'POST' })
  check(anonymous.status === 401, `anonymous live ticket: ${anonymous.status}`)

  const a = await liveClient(appOrigin, name, opts.session)
  const b = await liveClient(appOrigin, name, other)
  try {
    a.send({ type: 'hello' })
    const welcomeA = await a.next('welcome')
    const joined = await a.next('join')
    b.send({ type: 'hello' })
    const welcomeB = await b.next('welcome')
    check(
      joined.peer.id === welcomeB.you.id && welcomeB.peers.some(p => p.id === welcomeA.you.id),
      `live welcome/join: ${JSON.stringify({ welcomeA, joined, welcomeB })}`
    )

    const cursor = { type: 'cursor', path: '/docs/', hash: '', anchor: { x: 10, y: 20 } }
    a.send(cursor)
    a.send({ type: 'ping' })
    const seen = await b.next('cursor')
    check(
      seen.peerId === welcomeA.you.id && seen.path === '/docs/',
      `live cursor at the other peer: ${JSON.stringify(seen)}`
    )
    await a.next('pong')
    check(!a.heard.some(m => m.type === 'cursor'), 'live: a pointer came back to its sender')

    const added = await fetch(`${appOrigin}/api/sites/${name}/comments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.session.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body: 'Live', path: '/' }),
    })
    check(added.status === 201, `live: adding a comment: ${added.status}`)
    const { id } = (await added.json()) as { id: string }
    await Promise.all([a.next('comments'), b.next('comments')])
    await fetch(`${appOrigin}/api/sites/${name}/comments/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${opts.session.apiKey}` },
    })

    a.close()
    const left = await b.next('leave')
    check(left.peerId === welcomeA.you.id, `live leave: ${JSON.stringify(left)}`)
    step('live room: welcome and join, a pointer reaches the other peer only, comments, leave')
  } finally {
    a.close()
    b.close()
  }
}

/** Replace a Cookie header's pairs with the ones a response set (an emptied one is dropped). */
function withCookies(cookie: string, res: Response): string {
  const jar = new Map(
    cookie
      .split(/;\s*/)
      .filter(Boolean)
      .map(p => [p.slice(0, p.indexOf('=')), p] as const)
  )
  for (const pair of cookiePairs(res)) {
    const key = pair.slice(0, pair.indexOf('='))
    if (pair.endsWith('=')) jar.delete(key)
    else jar.set(key, pair)
  }
  return [...jar.values()].join('; ')
}

interface CliAccess {
  restricted: boolean
  audience?: { emails: { email: string; known: boolean }[] }
  warnings: string[]
}

/**
 * A new site deployed with no `--access`: the instance's default (`defaultAccess`). Only its
 * owner: another member is refused (the API's 404, and at the site's address the sign-in hop and
 * the site pass's refusal), and the share link serves it all the same. Then the owner opens it to
 * every member, and the member sees it.
 */
async function defaultAccessStep(ctx: {
  appOrigin: string
  meta: InstanceMetadata
  name: string
  work: string
  nonce: string
  fling: (...args: string[]) => Promise<unknown>
  opts: ScenarioOptions
  step: (line: string) => void
  propagationMs: number
}) {
  const { appOrigin, meta, name, fling, opts, step } = ctx
  const marker = `mine ${ctx.nonce}`
  const dir = siteDir(ctx.work, 'mine', { 'index.html': page('mine', marker) })
  const made = (await fling('deploy', dir, '--name', name)) as {
    site: CliSite
    access: string
    created?: boolean
  }
  const expected = defaultAccessOf(meta)
  check(
    made.created === true && made.access === expected && made.site.access === expected,
    `a new site's access: ${JSON.stringify(made)} (the instance's default is ${expected})`
  )
  const siteUrl = made.site.url
  step(`a new site with no --access gets the instance's default: ${expected}`)
  if (expected !== 'only_me') return
  // Only you is restricted: a member's site cookie (even the owner's) is not enough without a pass.
  if (opts.session.siteCookie) {
    const cookieOnly = await get(siteUrl, { cookie: opts.session.siteCookie })
    check(
      cookieOnly.status === 302,
      `only you, with a site cookie and no pass: ${cookieOnly.status}`
    )
  }

  const member = opts.member
  const asMember = (path: string) =>
    member
      ? fetch(`${appOrigin}${path}`, {
          headers: { authorization: `Bearer ${member.apiKey}`, accept: 'application/json' },
        })
      : null
  if (member) {
    const refused = await asMember(`/api/sites/${name}/comments`)
    check(refused?.status === 404, `a member reads an only-you site's comments: ${refused?.status}`)
    if (member.cookie) await refusedAt(siteUrl, appOrigin, member.cookie, 'a member')
    step('only you: another member gets 404s, and the site pass refuses them at its address')
  } else {
    step('only you: no second user, so the member checks are skipped')
  }

  const shared = (await fling('share', name)) as { shareUrl?: string }
  check(shared.shareUrl, `share: ${JSON.stringify(shared)}`)
  const viaShare = await get(shared.shareUrl)
  check(
    viaShare.status === 200 && viaShare.text.includes(marker),
    `share link on an only-you site: ${viaShare.status}`
  )
  step('the share link still serves a site only its owner sees')

  const opened = (await fling('access', name, '--members')) as { access?: string }
  check(opened.access === 'members', `fling access --members: ${JSON.stringify(opened)}`)
  if (member) {
    const reads = await asMember(`/api/sites/${name}/comments`)
    check(
      !meta.capabilities.comments || reads?.status === 200,
      `a member reads the comments once it is open to members: ${reads?.status}`
    )
    if (member.siteCookie) {
      await eventually(
        'the member sees it',
        siteUrl,
        r => r.status === 200 && r.text.includes(marker),
        {
          timeoutMs: ctx.propagationMs,
          headers: { cookie: member.siteCookie },
        }
      )
    }
    step('opened to members: the member sees it')
  } else {
    step('opened to members')
  }
}

async function audienceStep(ctx: {
  appOrigin: string
  name: string
  siteUrl: string
  shareUrl: string
  marker: string
  comments: boolean
  fling: (...args: string[]) => Promise<unknown>
  opts: ScenarioOptions
  step: (line: string) => void
  propagationMs: number
  mail: Mailbox | null
  instance: string
}) {
  const { appOrigin, name, siteUrl, shareUrl, marker, fling, opts, step, mail } = ctx
  const viewer = opts.member
  const outsider = opts.outsider
  // An admin outside the audience reads the site anyway; one who owns it proves nothing.
  const admin = opts.admin && opts.admin.email !== opts.session.email ? opts.admin : undefined
  if (!viewer || (!outsider && !admin)) {
    step('audience: needs two more users (skipped)')
    return
  }
  const restricted = (await fling('access', name, '--add', viewer.email)) as CliAccess
  check(
    restricted.restricted && restricted.audience?.emails.some(e => e.email === viewer.email),
    `fling access --add: ${JSON.stringify(restricted)}`
  )
  check(
    restricted.warnings.some(w => /share link/i.test(w)),
    `fling access warns of the share link: ${JSON.stringify(restricted.warnings)}`
  )
  step(`restricted ${name} to ${viewer.email}`)
  if (mail) {
    oneEmail(await mail.take(viewer), ['site.shared'], ctx.instance, 'the address added')
    noEmail(await mail.take(opts.session), 'the owner who shared')
    step('mail: the address added gets site.shared; the owner who shared gets nothing')
  }

  // The API: the viewer takes part in the comments; the outsider finds no such site.
  const asUser = (session: Session, path: string) =>
    fetch(`${appOrigin}${path}`, {
      headers: { authorization: `Bearer ${session.apiKey}`, accept: 'application/json' },
    })
  if (outsider) {
    const outsiderSite = await asUser(outsider, `/api/sites/${name}`)
    check(outsiderSite.status === 404, `outsider GET /api/sites/${name}: ${outsiderSite.status}`)
    const outsiderComments = await asUser(outsider, `/api/sites/${name}/comments`)
    check(outsiderComments.status === 404, `outsider comments: ${outsiderComments.status}`)
  }
  if (admin) {
    const adminSite = await asUser(admin, `/api/sites/${name}`)
    const body = adminSite.ok ? ((await adminSite.json()) as { owner?: string }) : {}
    check(
      adminSite.status === 200 && body.owner === opts.session.email,
      `admin GET /api/sites/${name}: ${adminSite.status} ${JSON.stringify(body)}`
    )
  }
  if (ctx.comments) {
    const viewerComments = await asUser(viewer, `/api/sites/${name}/comments`)
    check(viewerComments.status === 200, `viewer comments: ${viewerComments.status}`)
  }
  step(
    `API: the viewer reads the comments${outsider ? '; the outsider gets 404s, as for a missing site' : ''}${admin ? '; an admin outside the audience reads it' : ''}`
  )

  // Shared with me: the viewer finds the site there, by address; the outsider and the owner
  // (`fling ls --shared`, whose own sites never show) don't.
  const viewerShared = await sharedWith(appOrigin, viewer)
  check(
    viewerShared.some(s => s.name === name && s.via.direct),
    `viewer GET /api/shared: ${JSON.stringify(viewerShared)}`
  )
  // Shared with me is what was shared with you: never every site an admin may open.
  for (const who of [outsider, admin]) {
    if (!who) continue
    const theirs = await sharedWith(appOrigin, who)
    check(
      !theirs.some(s => s.name === name),
      `${who.email} GET /api/shared lists ${name}: ${JSON.stringify(theirs)}`
    )
  }
  const ownerShared = (await fling('ls', '--shared')) as { sites: SharedListed[] }
  check(
    !ownerShared.sites.some(s => s.name === name),
    `owner fling ls --shared lists their own site: ${JSON.stringify(ownerShared)}`
  )
  step('shared with me: the viewer sees it; the outsider (or admin) and the owner do not')

  // The site host: a member cookie doesn't open it; the viewer gets in through sign-in and the
  // site pass, the outsider is answered as for a missing site, at the address they asked for.
  // Only with browser sessions.
  if (viewer.cookie && viewer.siteCookie && outsider?.cookie) {
    const loginPrefix = `${appOrigin}/auth/login?return=`
    const toSignIn = await eventually(
      'restricted site sends a member to sign in',
      siteUrl,
      r => r.status === 302 && (r.location ?? '').startsWith(loginPrefix),
      { timeoutMs: ctx.propagationMs, headers: { cookie: viewer.siteCookie } }
    )
    const signIn = toSignIn.location as string
    const hop = await get(signIn, { cookie: viewer.cookie })
    const passUrl = hop.location ?? ''
    check(
      hop.status === 302 && passUrl.startsWith(`${new URL(siteUrl).origin}/_fling-pass?t=`),
      `viewer sign-in hop: ${hop.status} → ${passUrl}`
    )
    const pass = await get(passUrl)
    const passCookie = pass.headers
      .getSetCookie()
      .map(c => c.split(';')[0] as string)
      .find(c => c.startsWith('fling_pass='))
    check(
      pass.status === 302 && pass.location === '/' && passCookie,
      `site pass: ${pass.status} → ${pass.location}, cookie ${passCookie ? 'set' : 'missing'}`
    )
    const viewed = await get(siteUrl, { cookie: passCookie })
    check(viewed.status === 200 && viewed.text.includes(marker), `viewer view: ${viewed.status}`)
    // Review mode frames the site: nothing on the way through the pass may forbid framing.
    for (const r of [pass, viewed]) {
      const csp = r.headers.get('content-security-policy') ?? ''
      check(
        !r.headers.get('x-frame-options') && !/frame-ancestors/i.test(csp),
        `site pass responses refuse framing: x-frame-options ${r.headers.get('x-frame-options')}, csp ${csp}`
      )
    }
    step('viewer: sign-in → site pass → served (frameable)')

    await refusedAt(siteUrl, appOrigin, outsider.cookie, 'outsider')
    step("outsider: the sites' 404 page at the site's address, as for a site that does not exist")
  } else {
    step('audience: no browser sessions, so the site host checks are skipped')
  }

  const viaShare = await get(shareUrl)
  check(
    viaShare.status === 200 && viaShare.text.includes(marker),
    `share link on a restricted site: ${viaShare.status}`
  )
  step('the share link still serves the restricted site')
}

/** The sign-in link in the latest `/dev/mail` message to `to`: its token, or null. */
async function mailedLink(appOrigin: string, to: string): Promise<string | null> {
  const res = await fetch(`${appOrigin}/dev/mail`, { headers: { accept: 'application/json' } })
  check(res.ok, `GET /dev/mail: ${res.status}`)
  const { messages } = (await res.json()) as { messages: { id: string; to: string }[] }
  const latest = messages.find(m => m.to === to)
  if (!latest) return null
  const html = await (await fetch(`${appOrigin}/dev/mail/${encodeURIComponent(latest.id)}`)).text()
  return html.match(/\/auth\/link\?t=([A-Za-z0-9_-]{43})/)?.[1] ?? null
}

/**
 * Sign in by an emailed link as a browser would: open it (which takes nothing), then the confirm
 * page's form POST. The session it starts, with no API key (a guest may not hold one).
 */
async function signInByLink(appOrigin: string, email: string, token: string): Promise<Session> {
  for (let i = 0; i < 2; i++) {
    const opened = await get(`${appOrigin}/auth/link?t=${token}`)
    check(
      opened.status === 302 && (opened.location ?? '').includes('/sign-in/link'),
      `GET the sign-in link: ${opened.status} → ${opened.location}`
    )
    check(opened.headers.getSetCookie().length === 0, 'opening the sign-in link set cookies')
  }
  const res = await fetch(`${appOrigin}/auth/link/verify`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: appOrigin },
    body: new URLSearchParams({ t: token }).toString(),
  })
  const cookies = cookiePairs(res)
  check(
    res.status === 303 && cookies.some(c => c.startsWith('fling_site=')),
    `POST /auth/link/verify: ${res.status} → ${res.headers.get('location')}`
  )
  return {
    email,
    apiKey: '',
    cookie: cookies.join('; '),
    siteCookie: cookies.find(c => c.startsWith('fling_site=')),
  }
}

async function invitationStep(ctx: {
  appOrigin: string
  nonce: string
  work: string
  fling: (...args: string[]) => Promise<unknown>
  flingAs: (session: Session) => (...args: string[]) => Promise<unknown>
  made: string[]
  opts: ScenarioOptions
  step: (line: string) => void
  comments: boolean
  propagationMs: number
}) {
  const { appOrigin, nonce, work, fling, flingAs, made, opts, step } = ctx
  const admin = opts.admin as Session & { cookie: string }
  const guestEmail = 'guest@outside.test'
  const memberEmail = 'member@outside.test'
  const reviewName = `e2e-${nonce}-review`
  const teamName = `e2e-${nonce}-team`
  const memberSite = `e2e-${nonce}-invited`
  const as = (session: { cookie?: string }, method: string, path: string, body?: unknown) =>
    fetch(`${appOrigin}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        cookie: session.cookie ?? '',
        origin: appOrigin,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const drainNow = async () => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${appOrigin}/dev/notify/drain`, { method: 'POST' })
      check(res.ok, `POST /dev/notify/drain: ${res.status}`)
      if (((await res.json()) as { complete?: boolean }).complete) return
      await sleep(500)
    }
  }
  const marker = `review ${nonce}`
  const deployed = async (label: string, siteName: string, access: string) => {
    const dir = siteDir(work, label, { 'index.html': page(label, marker) })
    made.push(siteName)
    const out = (await fling('deploy', dir, '--name', siteName, '--access', access)) as {
      site: CliSite
    }
    check(out.site?.url, `deploy ${siteName}: ${JSON.stringify(out)}`)
    return out.site.url
  }
  const reviewUrl = await deployed('review', reviewName, 'members')
  const teamUrl = await deployed('team', teamName, 'members')

  // 1. The owner shares a site with an outsider: a guest invitation, and the share's email.
  const shared = (await fling('access', reviewName, '--add', guestEmail)) as CliAccess
  check(
    shared.restricted && shared.audience?.emails.some(e => e.email === guestEmail),
    `fling access --add ${guestEmail}: ${JSON.stringify(shared)}`
  )
  step(`shared ${reviewName} with ${guestEmail}, outside the email policy: invited as a guest`)

  // 2. The share's email carries a sign-in link; opening it takes nothing.
  await drainNow()
  const token = await mailedLink(appOrigin, guestEmail)
  check(token, `no sign-in link in the mail to ${guestEmail}`)
  // 3. The confirm page's POST signs them in.
  const guest = await signInByLink(appOrigin, guestEmail, token)
  const me = (await (await as(guest, 'GET', '/api/me')).json()) as { email?: string }
  check(me.email === guestEmail, `guest GET /api/me: ${JSON.stringify(me)}`)
  step("the share's email carries a sign-in link: opening it takes nothing, the form POST signs in")

  // 4. The guest sees the site through the site pass, and comments.
  const jar = {
    [new URL(appOrigin).host]: guest.cookie as string,
    [new URL(reviewUrl).host]: guest.siteCookie as string,
  }
  const viewed = await browse(reviewUrl, jar)
  check(
    viewed.status === 200 && viewed.text.includes(marker),
    `guest view of ${reviewName}: ${viewed.hops.join(' → ')} → ${viewed.status}`
  )
  if (ctx.comments) {
    const posted = await as(guest, 'POST', `/api/sites/${reviewName}/comments`, {
      body: 'Looks right to me',
      path: '/',
    })
    check(posted.status === 201, `guest comment: ${posted.status}`)
  }
  step(`guest: sign-in → site pass → served${ctx.comments ? ', and comments' : ''}`)

  // 5. Members-level sites answer them as missing ones; they deploy nothing, mint no keys, make no
  // groups.
  await refusedAt(teamUrl, appOrigin, guest.cookie as string, 'guest', guest.siteCookie)
  const nope = page('nope', 'nope')
  const deploy = await as(guest, 'POST', `/api/sites/e2e-${nonce}-nope/deploys`, {
    manifest: {
      files: [
        {
          path: 'index.html',
          sha256: createHash('sha256').update(nope).digest('hex'),
          size: Buffer.byteLength(nope),
          contentType: 'text/html; charset=utf-8',
        },
      ],
    },
  })
  check(deploy.status === 403, `guest deploy: ${deploy.status}`)
  const cli = await as(
    guest,
    'GET',
    `/auth/cli?redirect_uri=${encodeURIComponent('http://127.0.0.1:9/callback')}&hostname=e2e&state=e2e`
  )
  const cliTo = cli.headers.get('location') ?? ''
  check(
    !new URL(cliTo, appOrigin).searchParams.get('key'),
    `guest CLI login minted a key: ${cli.status} → ${cliTo}`
  )
  const group = await as(guest, 'POST', '/api/groups', { slug: `e2e-${nonce}-g`, name: 'Nope' })
  check(group.status === 403, `guest group create: ${group.status}`)
  step(`guest: ${teamName} (members only) is a missing site; no deploy, API key or group`)

  // 6. The admin revokes: the guest's next call is refused.
  const revoked = await as(
    admin,
    'DELETE',
    `/api/admin/invitations/${encodeURIComponent(guestEmail)}`
  )
  check(revoked.status === 200, `revoke ${guestEmail}: ${revoked.status}`)
  const after = await as(guest, 'GET', '/api/me')
  check(after.status === 401, `guest after revoking: ${after.status}`)
  step(`the admin revoked ${guestEmail}: their next API call is a 401`)

  // 7. The admin invites another outsider as a member, who signs in by link and deploys.
  const invited = await as(admin, 'POST', '/api/admin/invitations', { email: memberEmail })
  const invitedBody = (await invited.json()) as { sent?: boolean }
  check(invited.status === 201 && invitedBody.sent, `invite ${memberEmail}: ${invited.status}`)
  const memberToken = await mailedLink(appOrigin, memberEmail)
  check(memberToken, `no sign-in link in the invitation to ${memberEmail}`)
  const member = await signInByLink(appOrigin, memberEmail, memberToken)
  const minted = await as(
    member,
    'GET',
    `/auth/cli?redirect_uri=${encodeURIComponent('http://127.0.0.1:9/callback')}&hostname=e2e&state=e2e`
  )
  const apiKey = new URL(minted.headers.get('location') ?? '', appOrigin).searchParams.get('key')
  check(apiKey, `invited member CLI login: ${minted.status} → ${minted.headers.get('location')}`)
  const asMember = flingAs({ ...member, apiKey })
  try {
    const dir = siteDir(work, 'invited', { 'index.html': page('invited', `invited ${nonce}`) })
    const out = (await asMember('deploy', dir, '--name', memberSite, '--access', 'members')) as {
      status?: string
    }
    check(out.status === 'live', `invited member deploy: ${JSON.stringify(out)}`)
    step(
      `the admin invited ${memberEmail}: signed in by link, minted a key, deployed ${memberSite}`
    )

    // 8. Revoked, their `fling_site` stops opening members-level sites: the revocation list.
    const siteCookie = member.siteCookie as string
    const opened = await get(teamUrl, { cookie: siteCookie })
    check(opened.status === 200, `invited member view of ${teamName}: ${opened.status}`)
    const gone = await as(
      admin,
      'DELETE',
      `/api/admin/invitations/${encodeURIComponent(memberEmail)}`
    )
    check(gone.status === 200, `revoke ${memberEmail}: ${gone.status}`)
    await eventually(
      'a revoked member is sent to sign in',
      teamUrl,
      r => r.status === 302 && (r.location ?? '').startsWith(`${appOrigin}/auth/login?return=`),
      { timeoutMs: ctx.propagationMs, headers: { cookie: siteCookie } }
    )
    step(`the admin revoked ${memberEmail}: their site cookie now goes to sign in`)
  } finally {
    // 9. Clean up: their site, and the invitation (kept as revoked, for the record).
    await asMember('rm', memberSite, '--yes').catch(() => {})
    await as(admin, 'DELETE', `/api/admin/invitations/${encodeURIComponent(memberEmail)}`)
  }
}

interface SharedListed {
  name: string
  owner: string
  via: { direct: boolean; groups: string[] }
}

/** The sites shared with `session` (GET /api/shared). */
async function sharedWith(appOrigin: string, session: Session): Promise<SharedListed[]> {
  const res = await fetch(`${appOrigin}/api/shared`, {
    headers: { authorization: `Bearer ${session.apiKey}`, accept: 'application/json' },
  })
  check(res.status === 200, `GET /api/shared: ${res.status}`)
  return ((await res.json()) as { sites: SharedListed[] }).sites
}

interface ApiGroup {
  slug: string
  owner: string
  size: number
  canManage: boolean
  members: { email: string }[]
}

/**
 * The member makes a group; the owner sees it and its members and names it in the site's audience,
 * but may not change it. The outsider, once the member adds them, gets in (the API, and the site
 * pass on a fresh sign-in hop); once taken out, they are refused again on the next hop (a pass
 * already held would last its 5 minutes). Deleting the group while it is the audience's only
 * entry leaves the site restricted to its owner. The group is deleted however the step ends.
 */
async function groupStep(ctx: {
  appOrigin: string
  name: string
  nonce: string
  siteUrl: string
  comments: boolean
  fling: (...args: string[]) => Promise<unknown>
  flingAs: (session: Session) => (...args: string[]) => Promise<unknown>
  opts: ScenarioOptions
  step: (line: string) => void
  mail: Mailbox | null
  instance: string
}) {
  const { appOrigin, name, siteUrl, fling, opts, step, mail } = ctx
  const owner = opts.session
  const maker = opts.member
  const joiner = opts.outsider ?? opts.admin
  // An admin reads the site whether or not the group names them: only the way in is checked.
  const joinerIsAdmin = !opts.outsider
  if (!maker || !joiner) {
    step('groups: needs two more users (skipped)')
    return
  }
  const as = (session: Session, method: string, path: string, body?: unknown) =>
    fetch(`${appOrigin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.apiKey}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const slug = `e2e-${ctx.nonce}`
  const path = `/api/groups/${slug}`
  const made = await as(maker, 'POST', '/api/groups', { slug, name: `E2E ${ctx.nonce}` })
  check(made.status === 201, `member creates group ${slug}: ${made.status}`)
  try {
    // The owner sees it and who is in it, and may not change it.
    const seen = await as(owner, 'GET', path)
    const seenGroup = (await seen.json()) as ApiGroup
    check(
      seen.status === 200 && seenGroup.owner === maker.email && seenGroup.canManage === false,
      `owner GET ${path}: ${seen.status} ${JSON.stringify(seenGroup)}`
    )
    const listed = (await (await as(owner, 'GET', '/api/groups')).json()) as {
      groups: ApiGroup[]
    }
    check(
      listed.groups.some(g => g.slug === slug),
      `GET /api/groups lists ${slug}: ${JSON.stringify(listed.groups.map(g => g.slug))}`
    )
    const refusals = await Promise.all([
      as(owner, 'PATCH', path, { name: 'Taken over' }),
      as(owner, 'POST', `${path}/members`, { add: [owner.email] }),
      as(owner, 'DELETE', path),
    ])
    check(
      refusals.every(r => r.status === 403),
      `owner renames, changes members, deletes the member's group: ${refusals.map(r => r.status).join(', ')} (want 403s)`
    )
    step(`${maker.email} made group ${slug}; the owner sees it but gets 403 changing it`)

    const added = await as(maker, 'POST', `${path}/members`, { add: [joiner.email] })
    const addedGroup = (await added.json()) as ApiGroup
    check(
      added.status === 200 && addedGroup.members.some(m => m.email === joiner.email),
      `member adds ${joiner.email}: ${added.status} ${JSON.stringify(addedGroup)}`
    )
    if (mail) {
      oneEmail(await mail.take(joiner), ['group.member_added'], ctx.instance, 'the member added')
      noEmail(await mail.take(maker), "the group's owner who added them")
    }
    const access = (await fling('access', name, '--group', slug)) as {
      restricted: boolean
      audience?: { groups: { slug: string; size: number }[] }
    }
    check(
      access.restricted && access.audience?.groups.some(g => g.slug === slug && g.size === 1),
      `fling access --group: ${JSON.stringify(access)}`
    )
    const twins = (await fling('groups', 'list', '--members', joiner.email)) as {
      groups: { slug: string }[]
    }
    check(
      twins.groups.some(g => g.slug === slug),
      `fling groups --members ${joiner.email}: ${JSON.stringify(twins)}`
    )
    step(
      `${joiner.email} added to ${slug} (found by its members); the owner named ${slug} in ${name}'s audience`
    )
    if (mail) {
      oneEmail(await mail.take(joiner), ['site.shared_via_group'], ctx.instance, 'the group member')
      noEmail(await mail.take(owner), 'the owner who shared with the group')
      step(
        'mail: the member added gets group.member_added, then site.shared_via_group; the actors nothing'
      )
    }

    // In the group: the API lets them in, and a sign-in hop hands them a site pass.
    const site = () => as(joiner, 'GET', `/api/sites/${name}/comments`)
    const signIn = `${appOrigin}/auth/login?return=${encodeURIComponent(siteUrl)}`
    const origin = new URL(siteUrl).origin
    if (ctx.comments) {
      const inside = await site()
      check(inside.status === 200, `group member reads the comments: ${inside.status}`)
    }
    if (joiner.cookie) {
      const hop = await get(signIn, { cookie: joiner.cookie })
      check(
        hop.status === 302 && (hop.location ?? '').startsWith(`${origin}/_fling-pass?t=`),
        `group member sign-in hop: ${hop.status} → ${hop.location}`
      )
    }
    const joined = await sharedWith(appOrigin, joiner)
    check(
      joined.some(s => s.name === name && s.via.groups.includes(slug)),
      `group member GET /api/shared: ${JSON.stringify(joined)}`
    )
    step('through the group: the API, the sign-in hop (a site pass) and shared with me let them in')

    const removed = await as(maker, 'POST', `${path}/members`, { remove: [joiner.email] })
    check(removed.status === 200, `member removes ${joiner.email}: ${removed.status}`)
    if (ctx.comments && !joinerIsAdmin) {
      const outside = await site()
      check(outside.status === 404, `removed from the group, comments: ${outside.status}`)
    }
    if (joiner.cookie && !joinerIsAdmin) {
      await refusedAt(siteUrl, appOrigin, joiner.cookie, 'removed from the group')
    }
    const left = await sharedWith(appOrigin, joiner)
    check(
      !left.some(s => s.name === name),
      `removed from the group, GET /api/shared: ${JSON.stringify(left)}`
    )
    step(
      joinerIsAdmin
        ? 'out of the group: gone from shared with me (an admin still reads the site)'
        : 'out of the group: refused at once by the API, shared with me and the next sign-in hop'
    )

    // An opt-out holds: the joiner turns group emails off (read with the CLI, changed through
    // MCP), is added again, and hears nothing. Their choice goes back to the default after.
    const joinerCli = ctx.flingAs(joiner)
    if (mail) {
      const before = (await joinerCli('notifications')) as NotificationSettingsJson
      check(
        before.cells['group.member_added']?.email === 'on',
        `fling notifications: ${JSON.stringify(before)}`
      )
      const set = await mcpTool(appOrigin, joiner, 'fling_notifications_set', {
        cells: [{ event: 'group.member_added', channel: 'email', value: 'off' }],
      })
      const after = (await mcpTool(appOrigin, joiner, 'fling_notifications', {}))
        ?.structuredContent as NotificationSettingsJson | undefined
      check(
        !set?.isError && after?.cells['group.member_added']?.email === 'off',
        `MCP fling_notifications_set, then fling_notifications: ${JSON.stringify({ set, after })}`
      )
    }

    // Deleting the group while it is the audience's only entry never opens the site up: whoever
    // it let in is refused, and the site is its owner's alone.
    await as(maker, 'POST', `${path}/members`, { add: [joiner.email] })
    if (mail) {
      noEmail(await mail.take(joiner), 'opted out of group emails, added again')
      await joinerCli('notifications', 'set', 'group.member_added', 'email', 'default')
      const sent = (await joinerCli('notifications', 'sent')) as { sent: SentJson[] }
      check(
        sent.sent.some(m => m.eventKeys.includes('site.shared_via_group')),
        `fling notifications sent: ${JSON.stringify(sent)}`
      )
      step(
        'mail: settings read with the CLI and MCP; after an opt-out through MCP, nothing is sent (CLI sets it back)'
      )
    }
    const only = (await fling('access', name, '--remove', maker.email)) as {
      audience?: { emails: unknown[]; groups: unknown[] }
    }
    check(
      only.audience?.emails.length === 0 && only.audience.groups.length === 1,
      `the group alone in the audience: ${JSON.stringify(only.audience)}`
    )
    const deleted = await as(maker, 'DELETE', path)
    check(deleted.status === 204, `member deletes group ${slug}: ${deleted.status}`)
    const after = (await fling('access', name)) as {
      restricted: boolean
      audience?: { groups: { deleted?: boolean }[] }
    }
    check(
      after.restricted && after.audience?.groups.length === 1 && after.audience.groups[0]?.deleted,
      `after the group is deleted: ${JSON.stringify(after)}`
    )
    if (ctx.comments) {
      const refused = await site()
      check(refused.status === 404, `group deleted, its member reads comments: ${refused.status}`)
      const owned = await as(owner, 'GET', `/api/sites/${name}/comments`)
      check(owned.status === 200, `group deleted, the owner reads comments: ${owned.status}`)
    }
    const ownerSite = await as(owner, 'GET', `/api/sites/${name}`)
    check(ownerSite.status === 200, `group deleted, the owner GET /api/sites: ${ownerSite.status}`)
    if (joiner.cookie && owner.cookie) {
      await refusedAt(siteUrl, appOrigin, joiner.cookie, 'group deleted, its member')
      const ownerHop = await get(signIn, { cookie: owner.cookie })
      check(
        ownerHop.status === 302 && (ownerHop.location ?? '').startsWith(`${origin}/_fling-pass?t=`),
        `group deleted, the owner's sign-in hop: ${ownerHop.status} → ${ownerHop.location}`
      )
    }
    step(`group ${slug} deleted: the site stays restricted, to its owner only`)
  } finally {
    // However the step ended, the group goes (already gone: 404).
    const gone = await as(maker, 'DELETE', path)
    check([204, 404].includes(gone.status), `member deletes group ${slug}: ${gone.status}`)
  }
}

/**
 * Owners and publishers, through the CLI: the owner makes the member a publisher, who deploys,
 * finds the site in `fling ls` as its publisher, is refused its access, and rolls back; the owner
 * can't remove the last person owner; the member is made an owner and taken out again; a group's
 * member publishes through the group (with a third user). Mail where the dev drain is. Everything
 * is put back: the roles, the version served and the group.
 */
async function rolesStep(ctx: {
  appOrigin: string
  name: string
  nonce: string
  work: string
  groups: boolean
  fling: (...args: string[]) => Promise<unknown>
  flingAs: (session: Session) => (...args: string[]) => Promise<unknown>
  opts: ScenarioOptions
  step: (line: string) => void
  mail: Mailbox | null
  instance: string
}) {
  const { appOrigin, name, fling, opts, step, mail } = ctx
  const owner = opts.session
  const member = opts.member
  if (!member) {
    step('owners and publishers: needs a second user (skipped)')
    return
  }
  const asMember = ctx.flingAs(member)
  type Roles = {
    role?: string
    owners: { emails: { email: string }[]; groups: { slug: string }[] }
    publishers: { emails: { email: string }[]; groups: { slug: string }[] }
  }
  const emailsOf = (list: Roles['owners']) => list.emails.map(e => e.email)
  const refused = async (what: string, run: Promise<unknown>, want: RegExp) => {
    const err = await run.then(
      () => null,
      (e: Error) => e
    )
    check(err && want.test(err.message), `${what}: want a refusal matching ${want}, got ${err}`)
  }
  const servedBefore = ((await fling('info', name)) as { currentVersionId: string })
    .currentVersionId
  if (mail) {
    await mail.take(member)
    await mail.take(owner)
  }
  const groupSlug = `e2e-${ctx.nonce}-pub`
  const publisherByGroup = opts.outsider
  let groupMade = false
  try {
    // A publisher deploys, and lists the site as theirs to publish.
    const added = (await fling('publishers', name, '--add', member.email)) as Roles
    check(
      emailsOf(added.publishers).includes(member.email) && added.role === 'owner',
      `fling publishers --add: ${JSON.stringify(added)}`
    )
    if (mail) {
      oneEmail(await mail.take(member), ['site.publisher_added'], ctx.instance, 'the new publisher')
      noEmail(await mail.take(owner), 'the owner who added them')
    }
    const dir = siteDir(ctx.work, 'roles', {
      'index.html': page('roles', `published by the member ${ctx.nonce}`),
    })
    const deployed = (await asMember('deploy', dir, '--name', name)) as {
      status: string
      site: CliSite & { role?: string }
    }
    check(
      deployed.status === 'live' && deployed.site.role === 'publisher',
      `the publisher deploys: ${JSON.stringify(deployed)}`
    )
    const versions = (await asMember('versions', name)) as {
      versions: { id: string; publishedBy?: string }[]
    }
    check(
      versions.versions.find(v => v.id === deployed.site.currentVersionId)?.publishedBy ===
        member.email,
      `versions after the publisher's deploy: ${JSON.stringify(versions)}`
    )
    const listed = (await asMember('ls')) as { sites: { name: string; role?: string }[] }
    check(
      listed.sites.some(s => s.name === name && s.role === 'publisher'),
      `the publisher's fling ls: ${JSON.stringify(listed.sites)}`
    )
    step(`${member.email} is a publisher of ${name}: deploys it, and fling ls lists it as theirs`)

    await refused(
      "the publisher's fling access",
      asMember('access', name, '--members'),
      /No site named/
    )
    await refused(
      "the publisher's fling owners --add",
      asMember('owners', name, '--add', member.email),
      /No site named/
    )
    const rolled = (await asMember('rollback', name, servedBefore)) as CliSite
    check(
      rolled.currentVersionId === servedBefore,
      `the publisher rolls back: ${JSON.stringify(rolled)}`
    )
    step('the publisher may not change its access or owners, and rolls it back')

    await refused(
      'removing the last person owner',
      fling('owners', name, '--remove', owner.email),
      /at least one person as an owner/
    )
    const coOwned = (await fling('owners', name, '--add', member.email)) as Roles
    check(
      emailsOf(coOwned.owners).includes(member.email) &&
        !emailsOf(coOwned.publishers).includes(member.email),
      `fling owners --add (a publisher becomes an owner only): ${JSON.stringify(coOwned)}`
    )
    const asOwner = (await asMember('info', name)) as { role?: string; owners?: Roles['owners'] }
    check(asOwner.role === 'owner', `the co-owner's fling info: ${JSON.stringify(asOwner)}`)
    if (mail) {
      oneEmail(await mail.take(member), ['site.owner_added'], ctx.instance, 'the new owner')
    }
    const back = (await fling('owners', name, '--remove', member.email)) as Roles
    check(
      !emailsOf(back.owners).includes(member.email) && emailsOf(back.owners).includes(owner.email),
      `fling owners --remove: ${JSON.stringify(back)}`
    )
    const gone = (await asMember('ls')) as { sites: { name: string }[] }
    check(
      !gone.sites.some(s => s.name === name),
      `out of the owners, the member's fling ls: ${JSON.stringify(gone.sites)}`
    )
    step(
      `the last person owner stays (last_owner); ${member.email} made an owner${mail ? ' (told by email)' : ''}, then taken out`
    )

    // A group's member publishes through the group.
    if (ctx.groups && publisherByGroup) {
      const made = await fetch(`${appOrigin}/api/groups`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${owner.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          slug: groupSlug,
          name: `E2E publishers ${ctx.nonce}`,
          members: [publisherByGroup.email],
        }),
      })
      check(made.status === 201, `owner creates group ${groupSlug}: ${made.status}`)
      groupMade = true
      if (mail) await mail.take(publisherByGroup)
      await fling('publishers', name, '--group', groupSlug)
      if (mail) {
        oneEmail(
          await mail.take(publisherByGroup),
          ['site.publisher_added'],
          ctx.instance,
          'a publisher through a group'
        )
      }
      const viaGroup = (await ctx.flingAs(publisherByGroup)('deploy', dir, '--name', name)) as {
        status: string
        site: CliSite & { role?: string }
      }
      check(
        ['live', 'repointed'].includes(viaGroup.status) && viaGroup.site.role === 'publisher',
        `the group's member deploys: ${JSON.stringify(viaGroup)}`
      )
      step(`${publisherByGroup.email} publishes ${name} through the group ${groupSlug}`)
    } else {
      step(
        'owners and publishers: a publisher through a group needs groups and a third user (skipped)'
      )
    }
  } finally {
    // Put back what the step changed: the roles, the version served and the group.
    const reset = await fetch(`${appOrigin}/api/sites/${name}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${owner.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        owners: { emails: [owner.email], groups: [] },
        publishers: { emails: [], groups: [] },
      }),
    })
    check(reset.status === 200, `the owner resets the roles: ${reset.status}`)
    await fling('rollback', name, servedBefore)
    if (groupMade) {
      const res = await fetch(`${appOrigin}/api/groups/${groupSlug}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${owner.apiKey}` },
      })
      check([204, 404].includes(res.status), `owner deletes group ${groupSlug}: ${res.status}`)
    }
  }
}

/**
 * A public site of its own (removed with the others at the end): the member, made a publisher,
 * publishes `/30-10-26/` (or the owner does, without a second user); the folder serves the new
 * page while `/` and the other files still serve the first version; versions show where and by
 * whom; rolling back removes the folder's new page.
 */
/** A grey PNG of `width` × `height`: a stand-in for the thumbnail a browser draws. */
function greyPng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 0, 0, 0, 0], 8)
  const rows = Buffer.alloc((width + 1) * height, 0x99)
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  )
}

/**
 * Thumbnails over HTTP (a real browser draws them; here the PNG is made up): the owner keeps one
 * of the current version, the site reports it, its publisher replaces it and reads it back, someone
 * the site leaves out is refused (404) until its audience names them, and a thumbnail of a version
 * that is no longer current is a 409.
 */
async function thumbnailStep(ctx: {
  appOrigin: string
  name: string
  work: string
  nonce: string
  levels: boolean
  roles: boolean
  audiences: boolean
  fling: (...args: string[]) => Promise<unknown>
  made: string[]
  opts: ScenarioOptions
  step: (line: string) => void
}) {
  const { appOrigin, name, fling, step } = ctx
  const thumbnail = (session: Session, method: 'GET' | 'PUT', version?: string) =>
    fetch(
      `${appOrigin}/api/sites/${name}/thumbnail${version ? `?version=${version}` : ''}`,
      method === 'PUT'
        ? {
            method,
            headers: { authorization: `Bearer ${session.apiKey}`, 'content-type': 'image/png' },
            body: greyPng(480, 300),
          }
        : { headers: { authorization: `Bearer ${session.apiKey}` } }
    )
  const dir = siteDir(ctx.work, 'thumb', { 'index.html': page('thumb', `thumb ${ctx.nonce}`) })
  const first = (await fling(
    'deploy',
    dir,
    '--name',
    name,
    ...(ctx.levels ? ['--access', 'only_me'] : [])
  )) as { site: CliSite }
  ctx.made.push(name)
  const v1 = first.site.currentVersionId
  check(v1, `thumbnails: no current version for ${name}`)

  const put = await thumbnail(ctx.opts.session, 'PUT', v1)
  const putBody = await put.text()
  check(put.status === 200, `thumbnail PUT as the owner: ${put.status} ${putBody}`)
  const kept = JSON.parse(putBody) as { versionId: string; updatedAt: string }
  const site = (await (
    await fetch(`${appOrigin}/api/sites/${name}`, {
      headers: { authorization: `Bearer ${ctx.opts.session.apiKey}` },
    })
  ).json()) as { thumbnail?: { versionId: string; updatedAt: string } }
  check(
    kept.versionId === v1 && site.thumbnail?.updatedAt === kept.updatedAt,
    `thumbnail: kept ${JSON.stringify(kept)}, the site says ${JSON.stringify(site.thumbnail)}`
  )
  const own = await thumbnail(ctx.opts.session, 'GET')
  check(
    own.status === 200 && own.headers.get('content-type') === 'image/png',
    `thumbnail GET as the owner: ${own.status} ${own.headers.get('content-type')}`
  )
  step(`the owner kept a thumbnail of ${name}'s current version`)

  const { member, outsider } = ctx.opts
  if (ctx.roles && member) {
    await fling('publishers', name, '--add', member.email)
    const asPublisher = await thumbnail(member, 'PUT', v1)
    check(asPublisher.status === 200, `thumbnail PUT as a publisher: ${asPublisher.status}`)
    const read = await thumbnail(member, 'GET')
    check(read.status === 200, `thumbnail GET as a publisher: ${read.status}`)
    step('its publisher replaced the thumbnail and read it back')
  } else {
    step('thumbnails: no second user or no site roles, so the publisher checks are skipped')
  }

  if (outsider && ctx.levels && ctx.audiences) {
    const refused = await thumbnail(outsider, 'GET')
    check(refused.status === 404, `thumbnail GET by someone left out: ${refused.status}`)
    const notTheirs = await thumbnail(outsider, 'PUT', v1)
    check(notTheirs.status === 404, `thumbnail PUT by someone left out: ${notTheirs.status}`)
    await fling('access', name, '--add', outsider.email)
    const viewer = await thumbnail(outsider, 'GET')
    check(viewer.status === 200, `thumbnail GET by the audience: ${viewer.status}`)
    step('someone the site leaves out gets a 404; once in its audience, they read the thumbnail')
  } else {
    step('thumbnails: no outsider, so the refusal checks are skipped')
  }

  const v2Dir = siteDir(ctx.work, 'thumb-v2', {
    'index.html': page('thumb', `thumb v2 ${ctx.nonce}`),
  })
  await fling('deploy', v2Dir, '--name', name)
  const stale = await thumbnail(ctx.opts.session, 'PUT', v1)
  check(stale.status === 409, `thumbnail of a version no longer current: ${stale.status}`)
  step('a thumbnail of a version that is no longer current is a 409')
}

async function pathPublishStep(ctx: {
  name: string
  nonce: string
  work: string
  levels: boolean
  roles: boolean
  fling: (...args: string[]) => Promise<unknown>
  flingAs: (session: Session) => (...args: string[]) => Promise<unknown>
  made: string[]
  opts: ScenarioOptions
  step: (line: string) => void
  propagationMs: number
}) {
  const { name, nonce, fling, step } = ctx
  const base = siteDir(ctx.work, 'path-base', {
    'index.html': page('changelog', `changelog ${nonce}`),
    'notes.html': page('notes', `notes ${nonce}`),
    '30-10-26/index.html': page('draft', `draft week ${nonce}`),
  })
  const first = (await fling(
    'deploy',
    base,
    '--name',
    name,
    ...(ctx.levels ? ['--access', 'public'] : ['--public'])
  )) as { status: string; site: CliSite }
  ctx.made.push(name)
  check(first.status === 'live', `path publish base: ${JSON.stringify(first)}`)
  const siteUrl = first.site.url
  const v1 = first.site.currentVersionId
  check(v1, 'path publish base: no currentVersionId')
  const member = ctx.roles ? ctx.opts.member : undefined
  if (member) await fling('publishers', name, '--add', member.email)
  const publisher = member ?? ctx.opts.session
  const asPublisher = member ? ctx.flingAs(member) : fling

  const week = siteDir(ctx.work, 'path-week', {
    'index.html': page('week', `week ${nonce}`),
    'chart.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  })
  const layered = (await asPublisher('deploy', week, '--name', name, '--path', '30-10-26')) as {
    status: string
    path?: string
    url?: string
    site: CliSite
  }
  check(
    layered.status === 'live' &&
      layered.path === '30-10-26' &&
      layered.url === `${siteUrl}30-10-26/`,
    `path publish: ${JSON.stringify(layered)}`
  )
  await eventually(
    'the folder serves the new page',
    `${siteUrl}30-10-26/`,
    r => r.text.includes(`week ${nonce}`),
    { timeoutMs: ctx.propagationMs }
  )
  const home = await get(siteUrl)
  const notes = await get(`${siteUrl}notes.html`)
  const chart = await get(`${siteUrl}30-10-26/chart.svg`)
  check(
    home.text.includes(`changelog ${nonce}`) &&
      notes.text.includes(`notes ${nonce}`) &&
      chart.status === 200,
    `after the path publish: / ${home.status}, notes.html ${notes.status}, chart.svg ${chart.status}`
  )
  const versions = (await fling('versions', name)) as {
    versions: { id: string; path?: string; base?: string; publishedBy?: string }[]
  }
  const current = versions.versions.find(v => v.id === layered.site.currentVersionId)
  check(
    current?.path === '30-10-26' && current.base === v1 && current.publishedBy === publisher.email,
    `versions after the path publish: ${JSON.stringify(versions)}`
  )
  step(
    `${publisher.email} published /30-10-26/ of ${name}: the folder is new, / and notes.html are as they were`
  )

  await fling('rollback', name, v1)
  await eventually(
    "rollback removes the folder's new page",
    `${siteUrl}30-10-26/`,
    r => r.text.includes(`draft week ${nonce}`),
    { timeoutMs: ctx.propagationMs }
  )
  step('rolling back to the base removes the path publish')
}

async function adminStep(ctx: {
  appOrigin: string
  name: string
  opts: ScenarioOptions
  step: (line: string) => void
}) {
  const { appOrigin, name, opts, step } = ctx
  const admin = opts.admin as Session
  const owner = opts.session.email
  /** As the admin's browser (cookie, with the app's Origin) or their API key. */
  const call = (
    how: { cookie: string } | { key: string },
    method: string,
    path: string,
    body?: unknown
  ) =>
    fetch(`${appOrigin}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        ...('cookie' in how
          ? { cookie: how.cookie, origin: appOrigin }
          : { authorization: `Bearer ${how.key}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const listed = async (how: { cookie: string } | { key: string }) => {
    const res = await call(how, 'GET', `/api/admin/users?q=${encodeURIComponent(owner)}`)
    check(res.status === 200, `admin users list: ${res.status}`)
    const body = (await res.json()) as { users: { email: string; siteCount: number }[] }
    const row = body.users.find(u => u.email === owner)
    check(row && row.siteCount >= 1, `users list: ${JSON.stringify(body.users)}`)
  }
  /** Every site's listing, the owner's site among them (unless the list stops short of it). */
  const allSites = async (how: { cookie: string } | { key: string }) => {
    const res = await call(how, 'GET', '/api/admin/sites')
    check(res.status === 200, `admin sites list: ${res.status}`)
    const body = (await res.json()) as {
      sites: { name: string; owner: string }[]
      truncated: boolean
    }
    const row = body.sites.find(s => s.name === name)
    check(
      row?.owner === owner || (!row && body.truncated),
      `sites list: ${body.sites.length} sites, ${name} ${row ? `owned by ${row.owner}` : 'missing'}`
    )
  }

  /** The instance's settings: the env keys with their values, the secrets by name only. */
  const settings = async (how: { cookie: string } | { key: string }) => {
    const res = await call(how, 'GET', '/api/admin/settings')
    check(res.status === 200, `admin settings: ${res.status}`)
    const body = (await res.json()) as {
      settings: { key: string; value: unknown }[]
      secrets: Record<string, unknown>[]
    }
    check(
      body.settings.some(s => s.key === 'SITES_DOMAIN' && typeof s.value === 'string'),
      `settings: ${body.settings.length} keys, no SITES_DOMAIN`
    )
    const session = body.secrets.find(s => s.name === 'SESSION_SECRET')
    check(
      session?.set === true &&
        body.secrets.every(s => Object.keys(s).sort().join() === 'group,name,set'),
      `settings' secrets: ${JSON.stringify(body.secrets.map(s => Object.keys(s)))}`
    )
  }

  // Not admins: nothing there. A smoke run may sign in as one admin for both roles (a personal
  // instance has no second account), and then there is no non-admin to ask.
  if (admin.email !== owner) {
    const refused = await call({ key: opts.session.apiKey }, 'GET', '/api/admin/users')
    check(refused.status === 404, `a non-admin listing users: ${refused.status}`)
    const noSites = await call({ key: opts.session.apiKey }, 'GET', '/api/admin/sites')
    check(noSites.status === 404, `a non-admin listing every site: ${noSites.status}`)
    const noSettings = await call({ key: opts.session.apiKey }, 'GET', '/api/admin/settings')
    check(noSettings.status === 404, `a non-admin reading the settings: ${noSettings.status}`)
  }

  await listed({ key: admin.apiKey })
  await allSites({ key: admin.apiKey })
  await settings({ key: admin.apiKey })
  const viaKey = await call({ key: admin.apiKey }, 'POST', '/api/admin/impersonate', {
    email: owner,
  })
  check(viaKey.status === 403, `impersonating with an API key: ${viaKey.status}`)
  // Someone else's site: the key reads it and changes nothing; changes need the browser session.
  const othersSite = admin.email !== owner
  let spa = false
  if (othersSite) {
    const read = await call({ key: admin.apiKey }, 'GET', `/api/sites/${name}`)
    const detail = read.ok ? ((await read.json()) as { owner?: string; spa?: boolean }) : {}
    check(
      read.status === 200 && detail.owner === owner,
      `admin key GET /api/sites/${name}: ${read.status} ${JSON.stringify(detail)}`
    )
    spa = detail.spa === true
    const change = await call({ key: admin.apiKey }, 'PATCH', `/api/sites/${name}`, { spa })
    check(change.status === 404, `admin key PATCH /api/sites/${name}: ${change.status}`)
  }
  if (!admin.cookie) {
    step(
      `admin (API key): lists users (${owner} included), every site (${name} included) and the settings (secrets by name only)${othersSite ? `; reads ${name} but may not change it` : ''}; may not impersonate with a key`
    )
    return
  }
  const own = { cookie: admin.cookie }
  await listed(own)
  await allSites(own)
  await settings(own)

  const started = await call(own, 'POST', '/api/admin/impersonate', { email: owner })
  check(started.status === 200, `impersonate ${owner}: ${started.status} ${await started.text()}`)
  const as = { cookie: withCookies(admin.cookie, started) }
  const me = (await (await call(as, 'GET', '/api/me')).json()) as {
    email?: string
    impersonator?: string
  }
  check(
    me.email === owner && me.impersonator === admin.email,
    `/api/me while impersonating: ${JSON.stringify(me)}`
  )
  const sites = (await (await call(as, 'GET', '/api/sites')).json()) as {
    sites?: { name: string }[]
  }
  check(
    sites.sites?.some(s => s.name === name),
    `the owner's sites, impersonated: ${JSON.stringify(sites)}`
  )

  // No API key for them (`fling login`'s browser half).
  const cli = await call(
    as,
    'GET',
    `/auth/cli?redirect_uri=${encodeURIComponent('http://127.0.0.1:9/callback')}&hostname=e2e&state=e2e`
  )
  const back = new URL(cli.headers.get('location') ?? 'http://invalid/')
  check(
    back.searchParams.get('error') === 'impersonating' && !back.searchParams.get('key'),
    `fling login while impersonating: ${cli.status} ${cli.headers.get('location')}`
  )

  const stopped = await call(as, 'POST', '/api/admin/impersonate/stop')
  check(stopped.status === 200, `stop impersonating: ${stopped.status}`)
  const after = { cookie: withCookies(as.cookie, stopped) }
  const self = (await (await call(after, 'GET', '/api/me')).json()) as {
    email?: string
    admin?: boolean
    impersonator?: string
  }
  check(
    self.email === admin.email && self.admin === true && !self.impersonator,
    `/api/me after stopping: ${JSON.stringify(self)}`
  )
  const audit = (await (await call(after, 'GET', '/api/admin/audit')).json()) as {
    entries: { action: string; actor: string; target: string }[]
  }
  const [latest, before] = audit.entries
  check(
    latest?.action === 'impersonation.stop' &&
      before?.action === 'impersonation.start' &&
      [latest, before].every(e => e.actor === admin.email && e.target === owner),
    `audit: ${JSON.stringify(audit.entries.slice(0, 2))}`
  )
  if (othersSite) {
    // The same setting again: a change to the owner's site, on the record, that alters nothing.
    const changed = await call(after, 'PATCH', `/api/sites/${name}`, { spa })
    check(changed.status === 200, `admin session PATCH /api/sites/${name}: ${changed.status}`)
    const logged = (await (await call(after, 'GET', '/api/admin/audit')).json()) as {
      entries: { action: string; actor: string; target: string; owner?: string; change?: string }[]
    }
    const [entry] = logged.entries
    check(
      entry?.action === 'site.change' &&
        entry.change === 'site.settings' &&
        entry.actor === admin.email &&
        entry.target === name &&
        entry.owner === owner,
      `audit after an admin's change: ${JSON.stringify(logged.entries.slice(0, 1))}`
    )
  }
  step(
    `admin: lists users, every site (${name} included) and the settings; impersonates ${owner}, sees ${name}, is refused an API key, stops (audited)${othersSite ? `; changes ${name} from the browser (audited)` : ''}`
  )
}

export { ScenarioError }
