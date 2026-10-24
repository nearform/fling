// Node harness for the CloudFront Function. Builds the exact deployable source (build.mjs: the
// shell bundled with @fling/shared/site-routing) and evaluates it with placeholders substituted
// and the `cloudfront`/`crypto` imports swapped for stubs, so tests and the API's local dev server
// run the same code CloudFront does.

import nodeCrypto from 'node:crypto'
import { buildSiteRouter } from './build.mjs'

export const SITE_ROUTER_SOURCE = buildSiteRouter()

/** Substitute deploy-time placeholders. Use this when publishing the CloudFront Function too. */
export function renderSiteRouter({ appOrigin, siteScheme = 'https' }, source = SITE_ROUTER_SOURCE) {
  return source.replaceAll('__APP_ORIGIN__', appOrigin).replaceAll('__SITE_SCHEME__', siteScheme)
}

export function createSiteRouter({ kvs, appOrigin, siteScheme = 'https', now = Date.now }) {
  const body = renderSiteRouter({ appOrigin, siteScheme })
    .replace(/^import cf from ["']cloudfront["'];?\s*$/m, '')
    .replace(/^import crypto from ["']crypto["'];?\s*$/m, '')
  if (/^import\s/m.test(body)) throw new Error('the site router has an unexpected import')

  // Like the real KVS handle: get() rejects when the key is missing.
  const cf = {
    kvs: () => ({
      async get(key) {
        const value = await kvs.get(key)
        if (value === undefined || value === null) throw new Error(`Key ${key} not found`)
        return value
      },
    }),
  }
  const FakeDate = { now: () => now() }
  const factory = new Function('cf', 'crypto', 'Date', 'Buffer', `${body}\nreturn handler`)
  const handler = factory(cf, nodeCrypto, FakeDate, Buffer)
  return event => handler(structuredClone(event))
}

/** Build a CloudFront Functions viewer-request event. */
export function toCloudFrontEvent({ method = 'GET', host, path = '/', query, cookieHeader }) {
  // CloudFront passes query keys/values as they appear on the wire (still percent-encoded).
  const querystring = {}
  for (const part of (query ?? '').replace(/^\?/, '').split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const key = i < 0 ? part : part.slice(0, i)
    const value = i < 0 ? '' : part.slice(i + 1)
    const existing = querystring[key]
    if (existing) {
      existing.multiValue ??= [{ value: existing.value }]
      existing.multiValue.push({ value })
    } else {
      querystring[key] = { value }
    }
  }
  const cookies = {}
  for (const part of (cookieHeader ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    if (!name) continue
    if (cookies[name]) {
      cookies[name].multiValue ??= [{ value: cookies[name].value }]
      cookies[name].multiValue.push({ value })
    } else {
      cookies[name] = { value }
    }
  }
  const headers = { host: { value: host } }
  if (cookieHeader) headers.cookie = { value: cookieHeader }
  return {
    version: '1.0',
    context: { eventType: 'viewer-request' },
    viewer: { ip: '127.0.0.1' },
    request: { method, uri: path, querystring, headers, cookies },
  }
}

/** True when the router answered directly (redirect/405) rather than forwarding the request. */
export function isResponse(result) {
  return typeof result.statusCode === 'number'
}
