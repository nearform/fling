// A site server with no dependencies, already in its published form: the remote MCP's
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
      return json({ error: `Unknown time zone: ${zone}` }, 400)
    }
  },
}

export default {
  async fetch(request) {
    const route = routes[`${request.method} ${new URL(request.url).pathname}`]
    return route ? route(request) : json({ error: 'No such endpoint' }, 404)
  },
}
