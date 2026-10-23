import { probeUrl, waitUntilReachable } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { runShare } from '../src/commands/sites.ts'
import { createReadyWaiter, type ReadyWaiter, waitWithSpinner } from '../src/ready.ts'
import { jsonResponse, loggedInStore, mockFetch, site, testContext } from './helpers.ts'

/** A fake clock + fetch: each poll answers the next status (repeating the last). */
function fakeEdge(statuses: (number | 'error')[]) {
  let t = 0
  const calls: { url: string; init: RequestInit }[] = []
  return {
    calls,
    opts: {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        const s = statuses[Math.min(calls.length - 1, statuses.length - 1)]
        if (s === 'error') throw new TypeError('fetch failed')
        return new Response(null, { status: s as number })
      },
    },
  }
}

describe('waitUntilReachable', () => {
  it('polls past 404s (and network errors) until the edge routes the URL', async () => {
    const edge = fakeEdge([404, 'error', 404, 200])
    let waiting = 0
    const r = await waitUntilReachable('https://x.test/', {
      ...edge.opts,
      onWaiting: () => waiting++,
    })
    expect(r.ready).toBe(true)
    expect(edge.calls).toHaveLength(4)
    expect(waiting).toBe(1)
    expect(r.waitedMs).toBeGreaterThan(0)
    expect(edge.calls[0]?.init).toMatchObject({ redirect: 'manual', cache: 'no-store' })
  })

  it('counts a redirect (private site → sign-in), 401 and 403 as routed', async () => {
    for (const status of [302, 401, 403, 204]) {
      const edge = fakeEdge([status])
      expect(await waitUntilReachable('https://x.test/', edge.opts)).toEqual({
        ready: true,
        waitedMs: 0,
      })
    }
  })

  it('gives up at the timeout, backing off between polls', async () => {
    const edge = fakeEdge([404])
    const r = await waitUntilReachable('https://x.test/', { ...edge.opts, timeoutMs: 15_000 })
    expect(r).toEqual({ ready: false, waitedMs: 15_000 })
    // 750 ms growing to 2 s: well under 20 polls in 15 s
    expect(edge.calls.length).toBeGreaterThan(5)
    expect(edge.calls.length).toBeLessThan(20)
  })

  it('probes the root, or a file when there is no index.html', () => {
    expect(probeUrl('https://x.test/', ['index.html', 'a.css'])).toBe('https://x.test/')
    expect(probeUrl('https://x.test/', ['a.css', 'my page.html'])).toBe(
      'https://x.test/my%20page.html'
    )
    expect(probeUrl('https://x.test', ['data.json'])).toBe('https://x.test/data.json')
  })

  it('is skipped with FLING_NO_WAIT=1 and in tests', async () => {
    const skipped = createReadyWaiter({ env: { FLING_NO_WAIT: '1' } })
    expect(await skipped('https://x.test/', [])).toMatchObject({ ready: true, skipped: true })
    expect(
      await createReadyWaiter({ env: { VITEST: 'true' } })('https://x.test/', [])
    ).toMatchObject({ skipped: true })
  })
})

describe('waitWithSpinner', () => {
  it('shows "Waiting for the edge…" while waiting and the reload note on timeout', async () => {
    const lines: (string | null)[] = []
    const warnings: string[] = []
    const waiter: ReadyWaiter = async (_url, _paths, opts) => {
      opts?.onWaiting?.()
      return { ready: false, waitedMs: 15_000 }
    }
    const r = await waitWithSpinner(waiter, 'https://x.test/', [], {
      progress: l => lines.push(l),
      warn: m => warnings.push(m),
    })
    expect(r.ready).toBe(false)
    expect(lines.some(l => l?.includes('Waiting for the edge…'))).toBe(true)
    expect(lines.at(-1)).toBeNull()
    expect(warnings).toEqual([
      'https://x.test/ — it can take a few more seconds to appear everywhere; reload if you see a 404',
    ])
  })
})

describe('share waits for a new link', () => {
  it('polls the new share URL (a file, when the site has no index.html) and reports ready', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      'GET /api/sites/my-app': () => jsonResponse({ ...site(), versions: [] }),
      'POST /api/sites/my-app/share': () => jsonResponse({ shareUrl: 'https://s-new.test/' }),
      'GET /api/sites/my-app/versions/abcdef0123456789/files': () =>
        jsonResponse({
          versionId: 'abcdef0123456789',
          files: [{ path: 'page.html', size: 1, contentType: 'text/html' }],
          totalBytes: 1,
          generatedIndex: false,
        }),
    })
    const { ctx, out } = await testContext({ store, fetch: m.fetch, json: true })
    const waited: { url: string; paths: readonly string[] }[] = []
    ctx.waitReady = async (url, paths) => {
      waited.push({ url, paths })
      return { ready: false, waitedMs: 15_000 }
    }
    await runShare(ctx, 'my-app', {})
    expect(waited).toEqual([{ url: 'https://s-new.test/', paths: ['page.html'] }])
    expect(JSON.parse(out.content())).toMatchObject({ action: 'created', ready: false })
  })
})
