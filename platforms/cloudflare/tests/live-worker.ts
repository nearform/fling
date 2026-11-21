/**
 * The Worker the live-room tests run in workerd (bundled by live.test.ts): the real `LiveRoom`
 * Durable Object and the Worker's `GET /api/live` upgrade, plus `POST /publish/<siteId>` (the message
 * as its body) through the LiveHub adapter (what comments.ts does in the Worker).
 */
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import { DurableObjectLiveHub, handleLiveUpgrade, LIVE_PATH } from '../src/live.ts'

export { LiveRoom } from '../src/live.ts'

interface Env {
  LIVE_ROOMS: DurableObjectNamespace
  SECRET: string
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === LIVE_PATH) {
      return handleLiveUpgrade(request, env.LIVE_ROOMS, env.SECRET, new Date())
    }
    if (url.pathname.startsWith('/publish/')) {
      const body = await request.text()
      await new DurableObjectLiveHub(env.LIVE_ROOMS).publish(
        url.pathname.slice(9),
        body ? JSON.parse(body) : { type: 'comments' }
      )
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 404 })
  },
}
