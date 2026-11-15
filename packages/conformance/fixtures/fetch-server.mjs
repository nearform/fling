// A site server as a fetch handler, pre-bundled: imports only node:* and Fling's helpers (by the
// specifier the conformance suite passes in as FLING_HELPER, replaced before it is stored).

import { file, secret, viewer } from '__FLING_HELPER__'
import { createHash } from 'node:crypto'

console.log('fetch server starting')

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/hello') {
      return Response.json({
        kind: 'fetch',
        method: request.method,
        host: url.host,
        viewer: viewer(request),
        env: env.GREETING ?? null,
        secret: secret('GREETING'),
        digest: createHash('sha256').update('fling').digest('hex').slice(0, 8),
        cookie: request.headers.get('cookie'),
      })
    }
    if (url.pathname === '/api/echo') {
      return new Response(await request.text(), {
        status: 201,
        headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=60' },
      })
    }
    if (url.pathname === '/api/file') return file(url.searchParams.get('path') ?? '')
    if (url.pathname === '/api/missing-secret') {
      try {
        secret('NOT_DECLARED')
        return new Response('read it', { status: 500 })
      } catch (err) {
        return new Response(String(err.message), { status: 200 })
      }
    }
    if (url.pathname === '/api/stream') {
      const enc = new TextEncoder()
      const body = new ReadableStream({
        async start(controller) {
          for (const part of ['one ', 'two ', 'three']) {
            controller.enqueue(enc.encode(part))
            await new Promise(r => setTimeout(r, 20))
          }
          controller.close()
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/plain' } })
    }
    if (url.pathname === '/api/slow') {
      await new Promise(r => setTimeout(r, 5000))
      return new Response('late')
    }
    if (url.pathname === '/api/log') {
      console.log(`logged ${url.searchParams.get('n')}`)
      console.error('an error line')
      return new Response('ok')
    }
    return Response.json({ error: 'not here' }, { status: 404 })
  },
}
