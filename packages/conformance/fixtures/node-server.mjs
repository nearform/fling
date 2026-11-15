// A site server as a plain Node server, pre-bundled: node:http listening on PORT, its secrets in
// process.env, Fling's helpers by the specifier the conformance suite substitutes.

import { viewer } from '__FLING_HELPER__'
import { createServer } from 'node:http'

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/api/hello') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        kind: 'node',
        method: req.method,
        viewer: viewer(req),
        env: process.env.GREETING ?? null,
        home: process.env.HOME ?? null,
      })
    )
    return
  }
  if (url.pathname === '/api/echo') {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'text/plain' })
      res.end(Buffer.concat(chunks))
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not here"}')
}).listen(Number(process.env.PORT))
