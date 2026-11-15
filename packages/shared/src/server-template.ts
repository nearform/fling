// The site server fling_server_template gives an agent to start from, on either MCP server: one
// dependency-free file in its published form, `_fling/server.mjs`, that a remote client can publish
// as it is (it imports nothing, so it needs no bundling: server_not_bundled can't happen), and the
// `fling.json` that goes with it. A small route table with GET /api/health (the start probe's
// path), GET /api/me (the viewer) and one route that works something out on the server.
// examples/site-servers/remote-mcp is the same server, kept equal by a test.

/** The template's `_fling/server.mjs`. */
export const SERVER_TEMPLATE = `// A site server with no dependencies, already in its published form: the remote MCP's
// fling_publish takes _fling/server.mjs as it is, because it imports nothing but node:* (and
// may import the Fling helper). Fling runs it for /api/*; add a route to the table to grow it.

/** Who Fling says is calling, or null on a public site or through a share link. */
function viewerOf(request) {
  const header = request.headers.get('x-fling-viewer')
  return header ? JSON.parse(header) : null
}

const json = (body, status = 200) => Response.json(body, { status })

const routes = {
  // The start probe calls this (fling.json "health") before the version goes live.
  'GET /api/health': () => json({ ok: true }),
  'GET /api/me': request => json(viewerOf(request) ?? { email: null }),
  // GET /api/time?zone=Europe/London: the time now in a time zone, worked out on the server.
  'GET /api/time': request => {
    const zone = new URL(request.url).searchParams.get('zone') || 'UTC'
    try {
      const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: zone })
      return json({ zone, time: time.format(new Date()) })
    } catch {
      return json({ error: \`Unknown time zone: \${zone}\` }, 400)
    }
  },
}

export default {
  async fetch(request) {
    const route = routes[\`\${request.method} \${new URL(request.url).pathname}\`]
    return route ? route(request) : json({ error: 'No such endpoint' }, 404)
  },
}
`

/** The template's `fling.json`: the health path the start probe asks, no secrets. */
export const SERVER_TEMPLATE_CONFIG = { health: '/api/health' } as const
