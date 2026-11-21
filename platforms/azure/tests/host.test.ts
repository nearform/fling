/**
 * The Container App's handler: Front Door's check and the visitor's Host (front-door.ts) on their
 * own, and the whole host (host.ts) over the Cosmos DB emulator and Azurite where both are
 * configured (services.ts): the API and the sites hosts by X-Fling-Host, the hub's event
 * handler on the app host, and nothing for a request that went around Front Door.
 */
import { loadBaseConfig } from '@fling/api/config'
import { describe, expect, it } from 'vitest'
import { buildAzureDeps } from '../src/deps.ts'
import { behindFrontDoor, visitorRequest } from '../src/front-door.ts'
import { createAzureHost } from '../src/host.ts'
import { LIVE_EVENTS_PATH } from '../src/live.ts'
import { AZURITE_ENDPOINT, azuriteContainer, COSMOS_ENDPOINT, cosmosContainer } from './services.ts'

const SECRET = 'o'.repeat(40)
const ORIGIN = 'https://fling-app.example.azurecontainerapps.io'

const echoHost = async (request: Request) =>
  Response.json({ host: request.headers.get('host'), url: request.url, body: await request.text() })

describe('behind Front Door', () => {
  it('refuses a request without the origin secret, or with a wrong one', async () => {
    const fetch = behindFrontDoor(echoHost, { secret: SECRET })
    expect((await fetch(new Request(`${ORIGIN}/`))).status).toBe(403)
    const wrong = new Request(`${ORIGIN}/`, { headers: { 'x-origin-verify': 'x'.repeat(40) } })
    expect((await fetch(wrong)).status).toBe(403)
  })

  it('passes a missing header only where allowed, never a wrong one', async () => {
    const fetch = behindFrontDoor(echoHost, { secret: SECRET, allowMissing: true })
    expect((await fetch(new Request(`${ORIGIN}/`))).status).toBe(200)
    const wrong = new Request(`${ORIGIN}/`, { headers: { 'x-origin-verify': 'nope' } })
    expect((await fetch(wrong)).status).toBe(403)
  })

  it('routes by the host the visitor asked for, body and all', async () => {
    const fetch = behindFrontDoor(echoHost, { secret: SECRET })
    const res = await fetch(
      new Request(`${ORIGIN}/api/x?y=1`, {
        method: 'POST',
        headers: {
          'x-origin-verify': SECRET,
          'x-fling-host': 'hello.sites.example.test',
          host: 'fling-app.example.azurecontainerapps.io',
        },
        body: 'hi',
      })
    )
    expect(await res.json()).toEqual({
      host: 'hello.sites.example.test',
      url: 'https://hello.sites.example.test/api/x?y=1',
      body: 'hi',
    })
  })

  it('never routes by X-Forwarded-Host, which a visitor can write, and drops it', async () => {
    const fetch = behindFrontDoor(echoHost, { secret: SECRET })
    const spoofed = (extra: Record<string, string>) =>
      fetch(
        new Request(`${ORIGIN}/`, {
          headers: {
            'x-origin-verify': SECRET,
            'x-forwarded-host': 'other.sites.example.test',
            ...extra,
          },
        })
      )
    expect(await (await spoofed({})).json()).toMatchObject({ url: `${ORIGIN}/` })
    expect(
      await (await spoofed({ 'x-fling-host': 'hello.sites.example.test' })).json()
    ).toMatchObject({ host: 'hello.sites.example.test' })
    const seen = visitorRequest(
      new Request(`${ORIGIN}/`, {
        headers: { 'x-forwarded-host': 'other.example.test', 'x-fling-host': 'a.example.test' },
      })
    )
    expect(seen.headers.has('x-forwarded-host')).toBe(false)
    expect(seen.headers.has('x-fling-host')).toBe(false)
  })

  it("keeps a response to a site cookie out of Front Door's cache", async () => {
    const cached = async () =>
      new Response('file', { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
    const fetch = behindFrontDoor(cached, { secret: SECRET })
    const get = (cookie?: string) =>
      fetch(
        new Request(`${ORIGIN}/app.js`, {
          headers: { 'x-origin-verify': SECRET, ...(cookie ? { cookie } : {}) },
        })
      )
    const control = async (cookie?: string) => (await get(cookie)).headers.get('cache-control')
    expect(await control()).toBe('public, max-age=31536000, immutable')
    expect(await control('theme=dark')).toBe('public, max-age=31536000, immutable')
    expect(await control('a=1; fling_site=x')).toBe('private, max-age=31536000, immutable')
    expect(await control('fling_pass=y')).toBe('private, max-age=31536000, immutable')
  })

  it('leaves a request without X-Fling-Host or X-Forwarded-Host as it came', () => {
    const request = new Request(`${ORIGIN}/`)
    expect(visitorRequest(request)).toBe(request)
  })
})

describe.runIf(COSMOS_ENDPOINT && AZURITE_ENDPOINT)('the Azure host on the emulators', () => {
  const host = async () => {
    const base = loadBaseConfig({
      APP_ENV: 'production',
      APP_ORIGIN: 'https://fling.example.test',
      SITES_DOMAIN: 'sites.example.test',
      STORE_DRIVER: 'cosmos',
      STORAGE_DRIVER: 'azure-blob',
      KVS_DRIVER: 'table',
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      OIDC_ISSUER: 'https://idp.example.test',
      OIDC_CLIENT_ID: 'fling',
    })
    const config = {
      ...base,
      secrets: {
        sessionSecret: 's'.repeat(40),
        siteHmacKey: 'h'.repeat(40),
        originVerifySecret: SECRET,
        oidcClientSecret: 'c'.repeat(40),
      },
    }
    const blobs = await azuriteContainer()
    const azure = buildAzureDeps(config, {
      container: await cosmosContainer(),
      blobService: blobs.service,
      sitesContainer: blobs.container.containerName,
    })
    return createAzureHost({ azure, settings: {} })
  }
  const via = (host: string, path: string, init: RequestInit = {}) =>
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { 'x-origin-verify': SECRET, 'x-fling-host': host, ...init.headers },
    })

  it('answers the app host and the sites hosts by the name Front Door wrote', async () => {
    const { fetch } = await host()
    const meta = await fetch(via('fling.example.test', '/.well-known/fling'))
    expect(meta.status).toBe(200)
    expect(await meta.json()).toMatchObject({ sitesDomain: 'sites.example.test' })
    const site = await fetch(via('nobody-here.sites.example.test', '/'))
    expect(site.status).toBe(404)
    expect((await fetch(new Request(`${ORIGIN}/.well-known/fling`))).status).toBe(403)
  })

  it('has no event handler without live rooms, and no tick endpoints', async () => {
    const { fetch } = await host()
    expect(
      (await fetch(via('fling.example.test', LIVE_EVENTS_PATH, { method: 'POST' }))).status
    ).toBe(404)
    expect(
      (await fetch(via('fling.example.test', '/ticks/notify', { method: 'POST' }))).status
    ).toBe(404)
  })
})
