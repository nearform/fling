import { describe, expect, it } from 'vitest'
import { frameAt, loadAtVersion, servedVersion } from '../src/lib/preview-version'

/** A probe that answers the given versions in turn, counting the calls. */
function probes(...answers: (string | null)[]) {
  const asked = { n: 0 }
  const probe = async () => answers[Math.min(asked.n++, answers.length - 1)] ?? null
  return { probe, asked }
}

describe('servedVersion', () => {
  it("reads /_fling-version's header, uncached and with the site's cookies", async () => {
    let init: RequestInit | undefined
    let asked = ''
    const fetcher = (async (url: string, i: RequestInit) => {
      asked = url
      init = i
      return new Response(null, { status: 204, headers: { 'x-fling-version': 'V2' } })
    }) as unknown as typeof fetch
    expect(await servedVersion(fetcher)).toBe('V2')
    expect(asked).toBe('/_fling-version')
    expect(init).toMatchObject({ method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
  })

  it('says nothing for anything but the answer: a 404, a redirect refused, a network error', async () => {
    const answering = (res: () => Response) => (async () => res()) as unknown as typeof fetch
    expect(await servedVersion(answering(() => new Response('nope', { status: 404 })))).toBeNull()
    expect(
      await servedVersion(
        answering(() => {
          throw new TypeError('redirect')
        })
      )
    ).toBeNull()
  })
})

describe('loadAtVersion', () => {
  it('knows the version when the host said the same before and after the load', async () => {
    const { probe } = probes('V1', 'V1')
    expect(await loadAtVersion(probe, async () => 'win')).toEqual({ win: 'win', version: 'V1' })
  })

  it('does not know it when the host moved on during the load, or did not say', async () => {
    expect(await loadAtVersion(probes('V1', 'V2').probe, async () => 'w')).toEqual({
      win: 'w',
      version: null,
    })
    const silent = probes(null)
    expect((await loadAtVersion(silent.probe, async () => 'w')).version).toBeNull()
    expect(silent.asked.n).toBe(1)
  })
})

describe('frameAt', () => {
  const never = async () => {
    throw new Error('no reload expected')
  }

  it('draws the page loaded already when it is of the version asked, without asking again', async () => {
    const { probe, asked } = probes()
    expect(await frameAt('V2', { win: 'w', version: 'V2' }, probe, never)).toEqual({ win: 'w' })
    expect(asked.n).toBe(0)
  })

  it('reloads when the host serves the version asked but the page loaded is not known to be of it', async () => {
    for (const version of ['V1', null]) {
      let reloads = 0
      const reload = async () => {
        reloads++
        return { win: 'fresh', version: 'V2' }
      }
      expect(await frameAt('V2', { win: 'old', version }, probes('V2').probe, reload)).toEqual({
        win: 'fresh',
      })
      expect(reloads).toBe(1)
    }
  })

  it('is stale while the host serves another version, and draws nothing', async () => {
    expect(await frameAt('V2', { win: 'w', version: 'V1' }, probes('V1').probe, never)).toEqual({
      stale: 'V1',
    })
    expect(await frameAt('V2', { win: 'w', version: null }, probes(null).probe, never)).toEqual({
      stale: null,
    })
  })

  it('is stale when the fresh load cannot be told to be of the version asked', async () => {
    const reload = async () => ({ win: 'fresh', version: null })
    expect(await frameAt('V2', { win: 'w', version: 'V1' }, probes('V2').probe, reload)).toEqual({
      stale: null,
    })
  })
})
