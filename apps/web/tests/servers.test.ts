import type { ServerLogLine } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  parseLimit,
  requestCounts,
  secretOutcome,
  secretRows,
  stillAwaited,
} from '../src/lib/servers'

const at = '2026-11-15T12:00:00.000Z'

describe('site secrets as the site page lists them', () => {
  it('lists the declared names first, in order, set or missing, then the unused ones by name', () => {
    const rows = secretRows({
      secrets: [
        { name: 'ZED', setBy: 'ada@example.com', setAt: at },
        { name: 'API_KEY', setBy: 'ada@example.com', setAt: at },
        { name: 'ALPHA', setBy: 'bo@example.com', setAt: at },
      ],
      declared: ['WEBHOOK_URL', 'API_KEY'],
      missing: ['WEBHOOK_URL'],
    })
    expect(rows.map(r => [r.name, r.set !== null, r.declared])).toEqual([
      ['WEBHOOK_URL', false, true],
      ['API_KEY', true, true],
      ['ALPHA', true, false],
      ['ZED', true, false],
    ])
  })

  it('lists what a publish waiting for secrets still needs, after the live version’s', () => {
    const res = {
      secrets: [{ name: 'API_KEY', setBy: 'ada@example.com', setAt: at }],
      declared: [],
      missing: [],
    }
    const awaiting = { versionId: 'abc123def456', secrets: ['API_KEY', 'TOKEN'] }
    expect(secretRows(res, awaiting).map(r => [r.name, r.set !== null, r.waiting])).toEqual([
      ['API_KEY', true, true],
      ['TOKEN', false, true],
    ])
    expect(stillAwaited(res, awaiting)).toEqual(['TOKEN'])
  })

  it("takes what the waiting version declares and still needs from the API's answer", () => {
    const res = {
      secrets: [{ name: 'A', setBy: 'ada@example.com', setAt: at }],
      declared: [],
      missing: [],
      waiting: { versionId: 'v2', declared: ['A', 'B'], missing: ['B'] },
    }
    const awaiting = { versionId: 'v2', secrets: ['B'] }
    expect(secretRows(res, awaiting).map(r => [r.name, r.set !== null, r.waiting])).toEqual([
      ['A', true, true],
      ['B', false, true],
    ])
    expect(stillAwaited(res, awaiting)).toEqual(['B'])
  })

  it('lists nothing when there are none', () => {
    expect(secretRows({ secrets: [], declared: [], missing: [] })).toEqual([])
  })
})

describe('request counts from the server log', () => {
  const request = (status: number): ServerLogLine => ({
    at,
    versionId: 'v1',
    kind: 'request',
    method: 'GET',
    path: '/api/x',
    status,
    ms: 3,
    viewer: null,
  })

  it('counts request lines, and the 5xx among them, never output lines', () => {
    const output: ServerLogLine = { at, versionId: 'v1', kind: 'output', text: 'hi' }
    expect(requestCounts([request(200), request(404), request(503), output])).toEqual({
      requests: 3,
      errors: 1,
    })
    expect(requestCounts([])).toEqual({ requests: 0, errors: 0 })
  })
})

describe("an admin's limit as typed", () => {
  it('takes a whole number above zero, and blank as the instance’s', () => {
    expect(parseLimit('60')).toBe(60)
    expect(parseLimit(' 120 ')).toBe(120)
    expect(parseLimit('')).toBeNull()
    expect(parseLimit('  ')).toBeNull()
  })

  it('refuses anything else', () => {
    for (const bad of ['0', '-5', '1.5', '30s', 'abc']) expect(parseLimit(bad)).toBeUndefined()
  })

  it('reads each limit in its unit', () => {
    const format = Object.fromEntries(LIMITS.map(l => [l.key, l.format]))
    expect(format.timeoutSeconds?.(30)).toBe('30 s')
    expect(format.cpuMs?.(1000)).toBe('1 s')
    expect(format.cpuMs?.(250)).toBe('250 ms')
    expect(format.rps?.(100)).toBe('100')
  })
})

describe('what setting or removing a secret did', () => {
  const secret = { name: 'TOKEN', setBy: 'ada@example.com', setAt: at }

  it('says a waiting version went live, with its address', () => {
    const o = secretOutcome('set', {
      ...secret,
      deployed: { versionId: 'abc123def456', url: 'https://quotes.example.test/' },
    })
    expect(o).toMatchObject({ tone: 'success', url: 'https://quotes.example.test/' })
    expect(o.text).toContain('is now live')
  })

  it('shows why a waiting version did not go live, with the server’s log', () => {
    const o = secretOutcome('set', {
      ...secret,
      deployed: {
        versionId: 'abc123def456',
        error: 'server_failed_to_start',
        message: 'no answer',
        logs: ['boom'],
      },
    })
    expect(o).toMatchObject({ tone: 'error', logs: ['boom'] })
    expect(o.text).toContain('no answer')
    expect(o.text).toContain('It still waits')
  })

  it('names what a waiting version still needs', () => {
    const o = secretOutcome('set', { ...secret, missing: ['API_KEY'] })
    expect(o.tone).toBe('warning')
    expect(o.text).toContain('API_KEY')
  })

  it('says the live server restarted with the change, or shows why it did not', () => {
    expect(secretOutcome('set', { ...secret, live: { versionId: 'v', ok: true } }).tone).toBe(
      'success'
    )
    const failed = secretOutcome('removed', {
      name: 'TOKEN',
      live: {
        versionId: 'v',
        ok: false,
        error: 'server_failed_to_start',
        message: 'exited',
        logs: ['TOKEN is required'],
      },
    })
    expect(failed).toMatchObject({ tone: 'error', logs: ['TOKEN is required'] })
    expect(secretOutcome('removed', { name: 'OLD' }).tone).toBe('success')
  })
})
