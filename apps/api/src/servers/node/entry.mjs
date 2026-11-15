// The entry a Node runtime starts a site server with: `node entry.mjs <bundle> <helper-specifier>
// <helper-url>`. Plain JavaScript with no imports but node:*, so it runs as is wherever the
// server runs (the local runtime's child process, a Lambda Web Function's zip).
//
// The author's bundle imports Fling's helpers by the CLI package's name (`<cli>/server`): a
// resolve hook points that one specifier at helper.mjs, and nothing else is resolved for it, so a
// bundle that still imports a package fails here as it would anywhere. Then: a bundle whose
// default export has `fetch` is served over node:http on PORT, its env the site secrets (as a
// Worker's is); any other bundle is a Node server that listens on PORT itself.

import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const [bundle, helperSpecifier, helperUrl] = process.argv.slice(2)
if (!bundle || !helperSpecifier || !helperUrl) {
  console.error('usage: entry.mjs <bundle> <helper-specifier> <helper-url>')
  process.exit(2)
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === helperSpecifier) return { url: helperUrl, shortCircuit: true }
    return next(specifier, context)
  },
})

const mod = await import(pathToFileURL(bundle).href)
const app = mod.default

if (app && typeof app.fetch === 'function') {
  const port = Number(process.env.PORT)
  const host = process.env.HOST || '127.0.0.1'
  const env = Object.fromEntries(
    (process.env.FLING_SECRET_NAMES || '')
      .split(',')
      .filter(Boolean)
      .map(name => [name, process.env[name]])
  )
  createServer(async (req, res) => {
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const proto = req.headers['x-forwarded-proto'] || 'http'
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const headers = []
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) for (const x of v) headers.push([k, x])
      else if (v !== undefined) headers.push([k, v])
    }
    try {
      const request = new Request(`${proto}://${host}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: 'half',
      })
      const waits = []
      const ctx = { waitUntil: p => waits.push(p), passThroughOnException() {} }
      const response = await app.fetch(request, env, ctx)
      res.writeHead(response.status, [...response.headers].flat())
      if (response.body) for await (const chunk of response.body) res.write(chunk)
      res.end()
      await Promise.allSettled(waits)
    } catch (err) {
      console.error(err)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ error: { code: 'server_error', message: "The site's server failed" } })
        )
      } else res.destroy()
    }
  }).listen(port, host)
}
