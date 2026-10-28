import { describe, expect, it } from 'vitest'
import {
  applyPreferencesUpdate,
  CHANNEL_IDS,
  catalogueFor,
  describeNotificationSettings,
  EVENT_CATALOGUE,
  EVENT_KEYS,
  effectivePreference,
  eventDefinition,
  knownCells,
  NotificationPreferencesUpdateSchema,
  NotificationSettingsSchema,
  notificationSettings,
  preferencesUpdateOf,
} from '../src/notifications.ts'

describe('the event catalogue', () => {
  it('has one entry per key, each with a default for every channel', () => {
    expect(EVENT_CATALOGUE.map(e => e.key).sort()).toEqual([...EVENT_KEYS].sort())
    for (const event of EVENT_CATALOGUE) {
      expect(eventDefinition(event.key)).toBe(event)
      for (const channel of CHANNEL_IDS) expect(['on', 'off']).toContain(event.defaults[channel])
    }
  })

  it('leaves out events whose capability the instance lacks', () => {
    const gated = EVENT_CATALOGUE.filter(e => e.capability === 'comments')
    expect(gated.length).toBeGreaterThan(0)
    const without = catalogueFor({ comments: false })
    for (const event of gated) expect(without).not.toContain(event)
    const withComments = catalogueFor({ comments: true })
    for (const event of gated) expect(withComments).toContain(event)
    for (const event of EVENT_CATALOGUE.filter(e => !e.capability)) {
      expect(without).toContain(event)
    }
  })
})

describe('effectivePreference', () => {
  const event = EVENT_KEYS[0]
  const off = eventDefinition(event).defaults.email === 'on' ? 'off' : 'on'

  it('is the default without preferences, the own cell when set, off when muted', () => {
    expect(effectivePreference(null, event, 'email')).toBe(eventDefinition(event).defaults.email)
    expect(effectivePreference({ muted: false, cells: {} }, event, 'email')).toBe(
      eventDefinition(event).defaults.email
    )
    expect(
      effectivePreference({ muted: false, cells: { [event]: { email: off } } }, event, 'email')
    ).toBe(off)
    expect(
      effectivePreference({ muted: true, cells: { [event]: { email: 'on' } } }, event, 'email')
    ).toBe('off')
  })
})

describe('preference updates', () => {
  it('keeps only known events, channels and values', () => {
    expect(
      knownCells({
        'site.gone': { email: 'off' },
        'comment.created': { email: 'off', pigeon: 'on' },
        'comment.reply': { email: 'sometimes' },
      })
    ).toEqual({ 'comment.created': { email: 'off' } })
    expect(knownCells(null)).toEqual({})
  })

  it('sets cells, clears them with null, keeps muted unless given', () => {
    const set = applyPreferencesUpdate(null, { cells: { 'comment.created': { email: 'off' } } })
    expect(set).toEqual({ muted: false, cells: { 'comment.created': { email: 'off' } } })
    const muted = applyPreferencesUpdate(set, { muted: true })
    expect(muted).toEqual({ muted: true, cells: set.cells })
    expect(
      applyPreferencesUpdate(muted, { cells: { 'comment.created': { email: null } } })
    ).toEqual({ muted: true, cells: {} })
    expect(set.cells).toEqual({ 'comment.created': { email: 'off' } })
  })

  it('the request schema refuses unknown events and channels', () => {
    expect(NotificationPreferencesUpdateSchema.safeParse({ muted: true }).success).toBe(true)
    expect(
      NotificationPreferencesUpdateSchema.safeParse({ cells: { 'comment.reply': { email: null } } })
        .success
    ).toBe(true)
    expect(
      NotificationPreferencesUpdateSchema.safeParse({ cells: { 'site.gone': { email: 'off' } } })
        .success
    ).toBe(false)
    expect(
      NotificationPreferencesUpdateSchema.safeParse({ cells: { 'comment.reply': { fax: 'off' } } })
        .success
    ).toBe(false)
  })
})

describe('notificationSettings', () => {
  it('lists the instance’s events with effective cells for the channels that are on', () => {
    const settings = notificationSettings(
      {
        muted: false,
        cells: { 'site.shared': { email: 'off' }, 'comment.reply': { email: 'off' } },
      },
      { channels: ['email'], capabilities: { comments: false } }
    )
    expect(NotificationSettingsSchema.parse(settings)).toEqual(settings)
    expect(settings.channels).toEqual(['email'])
    expect(settings.events.map(e => e.key)).toEqual(
      catalogueFor({ comments: false }).map(e => e.key)
    )
    expect(settings.cells['site.shared']).toEqual({ email: 'off' })
    expect(settings.cells['comment.reply']).toBeUndefined()
    expect(settings.overrides).toEqual({ 'site.shared': { email: 'off' } })
    for (const event of settings.events) {
      if (event.key !== 'site.shared') {
        expect(settings.cells[event.key]).toEqual({ email: event.defaults.email })
      }
    }
  })

  it('shows every cell off while muted', () => {
    const settings = notificationSettings(
      { muted: true, cells: {} },
      { channels: ['email'], capabilities: { comments: true } }
    )
    expect(settings.muted).toBe(true)
    for (const row of Object.values(settings.cells)) expect(row).toEqual({ email: 'off' })
  })
})

describe('cell changes, as the CLI and the MCP tools take them', () => {
  it('become a PUT body: default is null, muted only when given', () => {
    expect(
      preferencesUpdateOf({
        cells: [
          { event: 'comment.created', channel: 'email', value: 'off' },
          { event: 'comment.reply', channel: 'email', value: 'default' },
        ],
      })
    ).toEqual({ cells: { 'comment.created': { email: 'off' }, 'comment.reply': { email: null } } })
    expect(preferencesUpdateOf({ muted: false })).toEqual({ muted: false })
    expect(preferencesUpdateOf({})).toEqual({})
  })

  it('read back as text: every event with its key, values per channel, and your own marked', () => {
    const prefs = applyPreferencesUpdate(null, { cells: { 'site.shared': { email: 'off' } } })
    const text = describeNotificationSettings(
      notificationSettings(prefs, { channels: ['email'], capabilities: { comments: true } })
    )
    for (const e of EVENT_CATALOGUE) expect(text).toContain(`- ${e.key}: ${e.title}`)
    expect(text).toContain('site.shared: Someone shares a site with you — email off (yours)')
    const muted = describeNotificationSettings(
      notificationSettings({ ...prefs, muted: true }, { channels: ['email'], capabilities: {} })
    )
    expect(muted).toMatch(/^All notifications are muted/)
  })
})
