import { describe, expect, it } from 'vitest'
import { metricsShown } from '../src/lib/metrics'

const on = { capabilities: { metrics: true } }

describe('the Metrics panel', () => {
  it('shows for owners, publishers and admins on an instance with metrics, never for others', () => {
    for (const role of ['owner', 'publisher', 'admin'] as const) {
      expect(metricsShown(on, { role }, false)).toBe(true)
    }
    expect(metricsShown(on, { role: undefined }, true)).toBe(true)
    expect(metricsShown(on, { role: undefined }, false)).toBe(false)
    expect(metricsShown({ capabilities: {} }, { role: 'owner' }, true)).toBe(false)
    expect(metricsShown(null, { role: 'owner' }, false)).toBe(false)
  })
})
