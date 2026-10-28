import {
  applyPreferencesUpdate,
  type NotificationPreferences,
  NotificationPreferencesUpdateSchema,
  notificationSettings,
} from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runNotifications,
  runNotificationsMute,
  runNotificationsSent,
  runNotificationsSet,
} from '../src/commands/notifications.ts'
import { createMcpServer } from '../src/mcp.ts'
import {
  captureError,
  INSTANCE,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  SERVER,
  tempStore,
  testContext,
} from './helpers.ts'

afterEach(runCleanups)

const WITH_NOTIFICATIONS = { ...INSTANCE, capabilities: { notifications: true, email: true } }

/** A server keeping one person's preferences, answering as the API does. */
function server() {
  let prefs: NotificationPreferences | null = null
  const puts: unknown[] = []
  const settings = () =>
    notificationSettings(prefs, { channels: ['email'], capabilities: { comments: true } })
  const m = mockFetch({
    'GET /api/me/notifications': () => jsonResponse(settings()),
    'PUT /api/me/notifications': (_url, init) => {
      const body = JSON.parse(String(init.body))
      puts.push(body)
      prefs = applyPreferencesUpdate(prefs, NotificationPreferencesUpdateSchema.parse(body))
      return jsonResponse(settings())
    },
    'GET /api/me/notifications/sent': () =>
      jsonResponse({
        sent: [
          {
            id: '01B',
            channel: 'email',
            eventKeys: ['comment.created', 'comment.reply'],
            subject: 'Example Fling: 2 updates on q3-report',
            providerId: 'p-2',
            sentAt: '2026-10-02T10:00:00.000Z',
          },
        ],
      }),
  })
  return { ...m, puts }
}

async function storeWith(instance: typeof INSTANCE = WITH_NOTIFICATIONS) {
  const { store } = await tempStore()
  await store.putServer(SERVER, { instance, apiKey: 'fling_test_key' })
  return store
}

describe('fling notifications', () => {
  it('prints events × channels with the effective values, marking your choices', async () => {
    const s = server()
    const { ctx } = await testContext({ store: await storeWith(), fetch: s.fetch })
    await runNotificationsSet(ctx, 'comment.created', 'email', 'off')
    const shown = await testContext({ store: await storeWith(), fetch: s.fetch })
    await runNotifications(shown.ctx)
    const text = shown.out.content()
    expect(text).toMatch(/SECTION\s+EVENT\s+EMAIL\s+WHEN/)
    expect(text).toMatch(/Comments\s+comment\.created\s+off\*\s+Someone comments on your site/)
    expect(text).toMatch(/Sharing\s+site\.shared\s+on\s+/)
    expect(text).toContain('* your choice')
    expect(text).not.toContain('Muted')
  })

  it('set sends one cell; default goes back to the catalogue', async () => {
    const s = server()
    const { ctx, log } = await testContext({ store: await storeWith(), fetch: s.fetch })
    await runNotificationsSet(ctx, 'comment.reply', 'email', 'off')
    await runNotificationsSet(ctx, 'comment.reply', 'email', 'default')
    expect(s.puts).toEqual([
      { cells: { 'comment.reply': { email: 'off' } } },
      { cells: { 'comment.reply': { email: null } } },
    ])
    expect(log.lines.join('\n')).toContain('comment.reply on email is back to the default (on)')
  })

  it('set refuses unknown events, channels and values, naming the ones there are', async () => {
    const s = server()
    const { ctx } = await testContext({ store: await storeWith(), fetch: s.fetch })
    const event = await captureError(runNotificationsSet(ctx, 'site.exploded', 'email', 'off'))
    expect(event.message).toBe('Example Fling has no event "site.exploded"')
    expect(event.hint).toContain('site.shared')
    const channel = await captureError(runNotificationsSet(ctx, 'site.shared', 'pigeon', 'on'))
    expect(channel.hint).toBe('Channels: email.')
    const value = await captureError(runNotificationsSet(ctx, 'site.shared', 'email', 'maybe'))
    expect(value.message).toContain('not on, off or default')
    expect(s.puts).toEqual([])
  })

  it('mute and unmute', async () => {
    const s = server()
    const { ctx, log } = await testContext({ store: await storeWith(), fetch: s.fetch })
    await runNotificationsMute(ctx, true)
    const shown = await testContext({ store: await storeWith(), fetch: s.fetch })
    await runNotifications(shown.ctx)
    expect(shown.out.content()).toContain('Muted: nothing is sent')
    await runNotificationsMute(ctx, false)
    expect(s.puts).toEqual([{ muted: true }, { muted: false }])
    expect(log.lines.join('\n')).toContain('Unmuted')
  })

  it('sent lists what went out; --json is the API answer', async () => {
    const s = server()
    const { ctx, out } = await testContext({ store: await storeWith(), fetch: s.fetch })
    await runNotificationsSent(ctx)
    expect(out.content()).toMatch(
      /email\s+Example Fling: 2 updates on q3-report\s+comment\.created, comment\.reply/
    )
    const json = await testContext({ store: await storeWith(), fetch: s.fetch, json: true })
    await runNotificationsSent(json.ctx)
    expect(JSON.parse(json.out.content()).sent[0].providerId).toBe('p-2')
  })

  it("passes on the server's refusal of the sent mail", async () => {
    const refusing = mockFetch({
      'GET /api/me/notifications/sent': () =>
        jsonResponse(
          {
            error: {
              code: 'impersonating',
              message: 'Not while impersonating member@example.test: the mail sent to them',
            },
          },
          403
        ),
    })
    const { ctx } = await testContext({ store: await storeWith(), fetch: refusing.fetch })
    const err = await captureError(runNotificationsSent(ctx))
    expect(err.message).toBe('Not while impersonating member@example.test: the mail sent to them')
  })

  it('says so on a Fling without notifications', async () => {
    const off = await storeWith({ ...INSTANCE, capabilities: { notifications: false } })
    const { ctx } = await testContext({ store: off, fetch: server().fetch })
    const err = await captureError(runNotifications(ctx))
    expect(err.message).toBe('Example Fling has no notifications')
    // A stored copy without the flag asks the server, whose 404 says the same.
    const { ctx: old } = await testContext({
      store: await loggedInStore(),
      fetch: mockFetch({}).fetch,
    })
    expect(
      (await captureError(runNotificationsSet(old, 'site.shared', 'email', 'off'))).message
    ).toBe('Example Fling has no notifications')
    expect((await captureError(runNotificationsSent(old))).message).toBe(
      'Example Fling has no notifications'
    )
  })
})

describe('MCP notification tools', () => {
  async function connect(capabilities: Record<string, boolean>, fetchImpl = server().fetch) {
    const store = await loggedInStore()
    const servers = [
      { url: SERVER, instance: { ...INSTANCE, capabilities }, current: true, signedIn: true },
    ]
    const mcp = createMcpServer({ store, fetch: fetchImpl, servers })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([mcp.connect(serverT), client.connect(clientT)])
    return client
  }
  const names = async (client: Client) => (await client.listTools()).tools.map(t => t.name)
  const text = (result: unknown) =>
    (result as { content: { text: string }[] }).content[0]?.text ?? ''

  it('are offered only where the instance has notifications', async () => {
    expect(await names(await connect({ notifications: true }))).toContain('fling_notifications_set')
    expect(await names(await connect({ notifications: false }))).not.toContain(
      'fling_notifications'
    )
  })

  it('read the settings and change cells and muted', async () => {
    const s = server()
    const client = await connect({ notifications: true }, s.fetch)
    const read = await client.callTool({ name: 'fling_notifications', arguments: {} })
    expect(text(read)).toContain('- comment.created: Someone comments on your site — email on')
    const set = await client.callTool({
      name: 'fling_notifications_set',
      arguments: { cells: [{ event: 'comment.created', channel: 'email', value: 'off' }] },
    })
    expect(text(set)).toContain(
      'comment.created: Someone comments on your site — email off (yours)'
    )
    await client.callTool({ name: 'fling_notifications_set', arguments: { muted: true } })
    expect(s.puts).toEqual([{ cells: { 'comment.created': { email: 'off' } } }, { muted: true }])
    const none = await client.callTool({ name: 'fling_notifications_set', arguments: {} })
    expect(none.isError).toBe(true)
  })
})
