// The CloudFront Function shell (cloudfront-js-2.0, viewer-request, on the sites distribution)
// around the shared routing decision, @fling/shared/site-routing. It reads the request, looks
// routes and the cookie key up in the associated KeyValueStore and turns the decision into a
// rewritten request (an S3 object key; unknown hosts go to `/_fling/missing`, which S3 404s into
// the error page) or a response, with the cookies it sets (the site pass) and the host's headers
// (a share host's `Referrer-Policy: no-referrer`). A rewrite's headers cannot be applied here: a
// viewer-request function never sees the response. So files S3 serves on a share host keep the
// browser's default referrer policy; adding the header to them would take a viewer-response
// association or a response headers policy on the sites distribution.
//
// edge/build.mjs bundles this into dist/site-router.js, the code deploy.yml publishes, after
// filling `__APP_ORIGIN__` and `__SITE_SCHEME__`. Same syntax rules as site-routing.ts.

import { SITE_HMAC_KVS_KEY } from '@fling/shared/route-keys'
import { routeSiteRequest } from '@fling/shared/site-routing'
import cf from 'cloudfront'
import crypto from 'crypto'

const kvs = cf.kvs()

const APP_ORIGIN = '__APP_ORIGIN__'
const SITE_SCHEME = '__SITE_SCHEME__'

// get() rejects when the key is missing.
function kvsGet(key) {
  return kvs.get(key).then(
    value => value,
    () => null
  )
}

function getCookieKey() {
  return kvsGet(SITE_HMAC_KVS_KEY)
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('base64url')
}

// The query string as CloudFront parsed it, back into `?k=v&k=v2&flag=`.
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

async function handler(event) {
  const request = event.request
  const cookie = request.cookies && request.cookies.fling_site
  const pass = request.cookies && request.cookies.fling_pass
  const decision = await routeSiteRequest(
    {
      method: request.method,
      host: request.headers.host ? request.headers.host.value : '',
      uri: request.uri,
      query: queryString(request.querystring),
      cookie: cookie ? cookie.value || '' : null,
      pass: pass ? pass.value || '' : null,
    },
    {
      appOrigin: APP_ORIGIN,
      siteScheme: SITE_SCHEME,
      nowSeconds: Math.floor(Date.now() / 1000),
      getRoute: kvsGet,
      getCookieKey: getCookieKey,
      hmac: hmac,
    }
  )
  if (decision.action === 'rewrite') {
    request.uri = decision.uri
    return request
  }
  const headers = {}
  Object.keys(decision.headers).forEach(name => {
    headers[name] = { value: decision.headers[name] }
  })
  const response = {
    statusCode: decision.status,
    statusDescription: decision.statusDescription,
    headers: headers,
  }
  if (decision.cookies) response.cookies = decision.cookies
  return response
}

// Stripped by build.mjs: CloudFront calls the top-level `handler`.
export { handler }
