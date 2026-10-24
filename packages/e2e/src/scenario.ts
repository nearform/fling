/**
 * The end-to-end scenario: what a Fling instance must do, whatever platform it runs on. It talks
 * to `appOrigin` only as a user would: the real CLI (apps/cli, run from source) for deploys and site
 * commands, plain HTTP for the sites, the API and the remote MCP endpoint.
 *
 *   metadata → whoami → deploy v1 (public) → view → 404 / trailing-slash → deploy v2 → view →
 *   rollback to v1 → private: anonymous redirect to sign-in, member view (with a site cookie) →
 *   share link → comments (owner and member; anonymous refused) → conditional-write race (concurrent first deploys of one name) → MCP publish →
 *   clean up (every site it made is removed).
 *
 * Content checks poll (up to `propagationMs`): on a real deployment a changed route can take a while
 * to reach the edge location the check lands on. New sites must not need it: the CLI's readiness
 * wait covers them, and the scenario fails if a new site is not routed when the CLI says it is.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type InstanceMetadata, InstanceMetadataSchema, instanceMetadataUrl } from '@fling/shared'
import { runCli } from './cli.ts'
import type { Session } from './sign-in.ts'

export interface ScenarioOptions {
  appOrigin: string
  session: Session
  /**
   * A second user of the instance, for what a member may do to someone else's site (comments);
   * without one those checks are skipped.
   */
  member?: Session
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

export async function runScenario(opts: ScenarioOptions): Promise<void> {
  const log = opts.log ?? (line => console.log(line))
  const step = (line: string) => log(`  ✓ ${line}`)
  const propagationMs = opts.propagationMs ?? 5_000
  const appOrigin = opts.appOrigin.replace(/\/+$/, '')
  const nonce = randomBytes(4).toString('hex')
  const name = `e2e-${nonce}`
  const raceName = `e2e-${nonce}-race`
  const mcpName = `e2e-${nonce}-mcp`
  const work = mkdtempSync(join(tmpdir(), 'fling-e2e-'))
  const fling = (...args: string[]) =>
    runCli(args, {
      serverUrl: appOrigin,
      apiKey: opts.session.apiKey,
      configDir: join(work, 'cli'),
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

    const who = (await fling('whoami')) as { email?: string }
    check(who.email === opts.session.email, `whoami: ${JSON.stringify(who)}`)
    step(`signed in as ${who.email}`)

    // Deploy (the CLI: manifest, presigned uploads, finalize, readiness wait) and view.
    const v1 = siteDir(work, 'v1', {
      'index.html': page('v1', `v1 ${nonce}`),
      'docs/index.html': page('docs', `docs ${nonce}`),
      'style.css': 'h1 { color: rebeccapurple }\n',
    })
    const first = (await fling('deploy', v1, '--name', name, '--public')) as {
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
    const second = (await fling('deploy', v2, '--name', name, '--public')) as { status: string }
    check(second.status === 'live', `second deploy: ${JSON.stringify(second)}`)
    await eventually('v2 served', siteUrl, r => r.text.includes(`v2 ${nonce}`), {
      timeoutMs: propagationMs,
    })
    step('deployed v2')

    const versions = (await fling('versions', name)) as { versions: { id: string }[] }
    check(versions.versions.length === 2, `versions: ${JSON.stringify(versions)}`)
    await fling('rollback', name, v1Id)
    await eventually('rollback served', siteUrl, r => r.text.includes(`v1 ${nonce}`), {
      timeoutMs: propagationMs,
    })
    step('rolled back to v1')

    // Private: anonymous visitors are sent to sign in; members (with the site cookie) see it.
    await fling('visibility', name, 'private')
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

    // Comments (review mode's data): the owner through the CLI, a member through the API, the
    // remote MCP tools; anonymous callers refused. Only where the instance has them.
    if (meta.capabilities.comments === true) {
      await commentsStep({ appOrigin, name, v1Id, fling, opts, step })
    } else {
      step('comments: turned off on this instance (skipped)')
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
            public: true,
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
}) {
  const { appOrigin, name, v1Id, fling, opts, step } = ctx
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

export { ScenarioError }
