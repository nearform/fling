/**
 * What the Container App does with a request before the Node host sees it. Every request reaches
 * it through Front Door (infra/edge.tf), which sends the Container App's own name as the Host
 * (Container Apps routes by it) and the name the visitor asked for as X-Forwarded-Host, and adds
 * `X-Origin-Verify: <ORIGIN_VERIFY_SECRET>` on its way to the origin.
 *
 * - A request without the secret went around Front Door, to the app's own address: 403. Without a
 *   secret configured (local runs) every request passes, and in development a missing header is
 *   allowed (a wrong one never is), as the core's own check (`originVerify`) does.
 * - The Host is put back: X-Forwarded-Host, which only Front Door can have set on a request that
 *   carries the secret, so the Node host routes the app host and the sites hosts as named.
 * - The hub's event handler (`LIVE_EVENTS_PATH` on the app host) goes to the live rooms.
 */
import { timingSafeEqual } from 'node:crypto'

export interface FrontDoorOptions {
  /** ORIGIN_VERIFY_SECRET */
  secret?: string
  /** a missing header passes (development) */
  allowMissing?: boolean
}

const forbidden = () =>
  Response.json(
    { error: { code: 'forbidden', message: 'Forbidden' } },
    { status: 403, headers: { 'cache-control': 'no-store' } }
  )

function verified(request: Request, opts: FrontDoorOptions): boolean {
  if (!opts.secret) return true
  const given = request.headers.get('x-origin-verify')
  if (given === null) return opts.allowMissing === true
  const a = Buffer.from(given)
  const b = Buffer.from(opts.secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The request as the visitor sent it: Host from X-Forwarded-Host, when Front Door set one. */
export function visitorRequest(request: Request): Request {
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  if (!forwarded) return request
  const url = new URL(request.url)
  url.host = forwarded
  const headers = new Headers(request.headers)
  headers.set('host', forwarded)
  headers.delete('x-forwarded-host')
  return new Request(url, {
    method: request.method,
    headers,
    ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    redirect: 'manual',
  } as RequestInit)
}

/** `fetch` behind Front Door's check, with the visitor's Host. */
export function behindFrontDoor(
  fetch: (request: Request) => Promise<Response>,
  opts: FrontDoorOptions
): (request: Request) => Promise<Response> {
  return async request => {
    if (!verified(request, opts)) return forbidden()
    return fetch(visitorRequest(request))
  }
}
