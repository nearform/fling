// Fling site router: CloudFront Function (cloudfront-js-2.0, viewer-request) on the sites
// distribution. Maps `<name>.<domain>` / `s--<token>.<domain>` to
// `/sites/<id>/<v><path>` in S3 via the associated KeyValueStore, enforcing the
// `fling_site` cookie for private sites. Unknown hosts go to `/_fling/missing` (S3 404 →
// custom error page).
//
// Runtime notes: ES5.1 + a few ES6+ features only (no destructuring, spread, default
// params, for-of, optional chaining). `__APP_ORIGIN__` and `__SITE_SCHEME__` are replaced at
// deploy time. Contracts: packages/shared/src/{hosts,kvs,site-cookie}.ts — keep in step.

import cf from 'cloudfront'
import crypto from 'crypto'

const kvs = cf.kvs()

const APP_ORIGIN = '__APP_ORIGIN__'
const SITE_SCHEME = '__SITE_SCHEME__'
const MISSING_KEY = '/_fling/missing'
const NOT_FOUND_PAGE = '/_fling/404.html'
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const SHARE_RE = /^s--([a-z0-9]{20})$/
// RESERVED_SITE_NAMES in shared/hosts.ts — keep in step.
const RESERVED = [
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'cdn',
  'docs-fling',
  'fling',
  'help',
  'login',
  'mail',
  'static',
  'status',
  'www',
]
const DOT_SEGMENT_RE = /(^|\/)(\.|%2e){1,2}(\/|$)/i

// Same rules as parseLabel() in shared/hosts.ts; returns the KVS key or null.
function kvsKeyForLabel(label) {
  if (label.indexOf('--') === -1) {
    if (label.length <= 50 && SLUG_RE.test(label) && RESERVED.indexOf(label) === -1) {
      return { key: `site:${label}`, share: false }
    }
    return null
  }
  const m = SHARE_RE.exec(label)
  return m ? { key: `share:${m[1]}`, share: true } : null
}

async function kvsGet(key) {
  try {
    return await kvs.get(key)
  } catch (_e) {
    return null
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Mirrors verifySiteCookie() in shared/site-cookie.ts.
function validCookie(value, key, nowSeconds) {
  const parts = value.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  const expected = crypto.createHmac('sha256', key).update(parts[0]).digest('base64url')
  if (!safeEqual(expected, parts[1])) return false
  try {
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    return typeof p.e === 'string' && typeof p.x === 'number' && p.x > nowSeconds
  } catch (_e) {
    return false
  }
}

function queryString(qs) {
  const out = []
  Object.keys(qs || {}).forEach(k => {
    const q = qs[k]
    const values = q.multiValue ? q.multiValue : [q]
    values.forEach(v => {
      out.push(v.value === undefined || v.value === '' ? `${k}=` : `${k}=${v.value}`)
    })
  })
  return out.length ? `?${out.join('&')}` : ''
}

function redirect(statusCode, location, noStore) {
  const headers = { location: { value: location } }
  if (noStore) headers['cache-control'] = { value: 'no-store' }
  return {
    statusCode,
    statusDescription: statusCode === 301 ? 'Moved Permanently' : 'Found',
    headers,
  }
}

// biome-ignore lint/correctness/noUnusedVariables: CloudFront entry point
async function handler(event) {
  const request = event.request
  const uri = request.uri

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return {
      statusCode: 405,
      statusDescription: 'Method Not Allowed',
      headers: { allow: { value: 'GET, HEAD' }, 'cache-control': { value: 'no-store' } },
    }
  }
  if (uri === NOT_FOUND_PAGE) return request

  const host = request.headers.host ? request.headers.host.value.toLowerCase() : ''
  const target = kvsKeyForLabel(host.split(':')[0].split('.')[0])
  const raw = target ? await kvsGet(target.key) : null
  let site = null
  try {
    site = raw ? JSON.parse(raw) : null
  } catch (_e) {
    site = null
  }
  if (!site || !site.id || !site.v || DOT_SEGMENT_RE.test(uri)) {
    request.uri = MISSING_KEY
    return request
  }

  const query = queryString(request.querystring)

  if (site.vis !== 'public' && !target.share) {
    const cookie = request.cookies && request.cookies.fling_site
    const hmacKey = cookie ? await kvsGet('cfg:site-hmac') : null
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (!hmacKey || !validCookie(cookie.value || '', hmacKey, nowSeconds)) {
      const back = `${SITE_SCHEME}://${host}${uri}${query}`
      return redirect(302, `${APP_ORIGIN}/auth/login?return=${encodeURIComponent(back)}`, true)
    }
  }

  let path = uri
  if (path.endsWith('/')) {
    path += 'index.html'
  } else if (path.slice(path.lastIndexOf('/') + 1).indexOf('.') === -1) {
    if (!site.spa) return redirect(301, `${uri}/${query}`, false)
    path = '/index.html'
  }
  request.uri = `/sites/${site.id}/${site.v}${path}`
  return request
}
