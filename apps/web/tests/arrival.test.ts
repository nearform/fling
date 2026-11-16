import { describe, expect, it } from 'vitest'
import { ARRIVAL_WAIT_MS, shouldHold, waitForArrival } from '../src/lib/arrival'

const APP = 'https://fling.test'
const at = (pathname: string, hostname = 'fresh.sites.test') => ({ pathname, hostname })

/** A fetch answering the edge probe with `edge` and the API with `arriving`, recording calls. */
function fake(edge: number | 'redirect', arriving: boolean | 'error' = true) {
  const calls: string[] = []
  const impl = async (url: string) => {
    calls.push(url)
    if (url === '/_fling-version') {
      return edge === 'redirect'
        ? ({ type: 'opaqueredirect', status: 0 } as Response)
        : new Response(null, { status: edge })
    }
    if (arriving === 'error') return new Response('{}', { status: 401 })
    return Response.json({ arriving })
  }
  return { impl, calls }
}

describe('shouldHold', () => {
  it('holds at the root of a host the edge lacks, for a site the API says is arriving', async () => {
    const f = fake(404)
    expect(await shouldHold(APP, at('/'), f.impl)).toBe(true)
    expect(f.calls).toEqual(['/_fling-version', `${APP}/api/sites/fresh/arrival`])
  })

  it('asks nothing off the root page', async () => {
    const f = fake(404)
    expect(await shouldHold(APP, at('/missing.html'), f.impl)).toBe(false)
    expect(f.calls).toEqual([])
  })

  it('never asks the API when the edge has the site (a missing file, or sign-in first)', async () => {
    for (const edge of [204, 'redirect'] as const) {
      const f = fake(edge)
      expect(await shouldHold(APP, at('/'), f.impl)).toBe(false)
      expect(f.calls).toEqual(['/_fling-version'])
    }
  })

  it('says 404 when the API says no, or refuses', async () => {
    expect(await shouldHold(APP, at('/'), fake(404, false).impl)).toBe(false)
    expect(await shouldHold(APP, at('/'), fake(404, 'error').impl)).toBe(false)
  })
})

/** A clock that sleeping moves on, so the wait runs at once. */
function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

describe('waitForArrival', () => {
  it('probes the edge until the site is there', async () => {
    let probes = 0
    const impl = async () => new Response(null, { status: ++probes < 3 ? 404 : 204 })
    const c = clock()
    const arrived = await waitForArrival(impl, c.sleep, c.now)
    expect(arrived).toBe(true)
    expect(probes).toBe(3)
  })

  it(`gives up after ${ARRIVAL_WAIT_MS / 1000} s`, async () => {
    const c = clock()
    const impl = async () => new Response(null, { status: 404 })
    expect(await waitForArrival(impl, c.sleep, c.now)).toBe(false)
    expect(c.now()).toBeGreaterThanOrEqual(ARRIVAL_WAIT_MS)
  })
})
