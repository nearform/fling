// The Guide's facts the API owns are pinned in @fling/shared (it cannot import the API): they
// match the constants that decide them.
import { PINNED_GUIDE_FACTS } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { AUDIT_TTL_DAYS } from '../src/audit.ts'
import { IMPERSONATION_TTL_SECONDS } from '../src/auth/session.ts'
import { INVITATION_LINK_TTL_SECONDS } from '../src/auth/sign-in-link.ts'
import { loadBaseConfig } from '../src/config.ts'
import { SUPPRESSION_MS } from '../src/notifications/drain.ts'

const DAY = 24 * 60 * 60

describe('the Guide facts pinned from the API', () => {
  it('match the constants', () => {
    expect(PINNED_GUIDE_FACTS['audit-days']).toBe(`${AUDIT_TTL_DAYS} days`)
    expect(IMPERSONATION_TTL_SECONDS).toBe(60 * 60)
    expect(PINNED_GUIDE_FACTS['impersonation-ttl']).toBe('an hour')
    expect(PINNED_GUIDE_FACTS['invite-link-ttl']).toBe(`${INVITATION_LINK_TTL_SECONDS / DAY} days`)
    expect(PINNED_GUIDE_FACTS['suppression-days']).toBe(`${SUPPRESSION_MS / 1000 / DAY} days`)
  })

  it('match the default an instance gets when it configures nothing', () => {
    expect(PINNED_GUIDE_FACTS['invites-per-day']).toBe(String(loadBaseConfig({}).invitesPerDay))
  })
})
