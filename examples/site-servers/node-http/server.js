// A site server in the plain Node style: no framework, no dependencies, nothing to install.
// Fling runs it for /api/* and sets PORT; the viewer arrives in the x-fling-viewer header,
// set by Fling from the visitor's sign-in (anything the browser sent under that name is dropped).
import { createServer } from 'node:http'

function viewerOf(req) {
  const header = req.headers['x-fling-viewer']
  return typeof header === 'string' ? JSON.parse(header) : null
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true })
  if (req.method === 'GET' && pathname === '/api/me') {
    return send(res, 200, viewerOf(req) ?? { email: null })
  }
  send(res, 404, { error: 'No such endpoint' })
})

// Fling sets PORT on every platform; the fallback is for running it with plain `node server.js`.
server.listen(Number(process.env.PORT ?? 8787))
