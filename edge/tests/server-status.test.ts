import {
  restoredServerStatus,
  SERVER_STAND_IN_STATUS,
  SERVER_STATUS_HEADER,
} from '@fling/shared/route-keys'
import { describe, expect, it } from 'vitest'
import { buildReadableServerStatus, EDGE_FUNCTION_MAX_BYTES } from '../build.mjs'
import { createServerStatus, SERVER_STATUS_SOURCE, toViewerResponseEvent } from '../index.mjs'

const restore = createServerStatus()

describe('the server status function', () => {
  it("puts a server's 404 back and takes the header off", async () => {
    const res = await restore(
      toViewerResponseEvent({
        status: SERVER_STAND_IN_STATUS,
        headers: { [SERVER_STATUS_HEADER]: '404', 'content-type': 'application/json' },
      })
    )
    expect(res.statusCode).toBe(404)
    expect(res.statusDescription).toBe('Not Found')
    expect(res.headers?.[SERVER_STATUS_HEADER]).toBeUndefined()
    expect(res.headers?.['content-type']?.value).toBe('application/json')
  })

  it("puts a server's 403 back", async () => {
    const res = await restore(
      toViewerResponseEvent({
        status: SERVER_STAND_IN_STATUS,
        headers: { [SERVER_STATUS_HEADER]: '403' },
      })
    )
    expect(res.statusCode).toBe(403)
    expect(res.statusDescription).toBe('Forbidden')
  })

  it("leaves a server's own 300, without the header, as it is", async () => {
    const event = toViewerResponseEvent({
      status: SERVER_STAND_IN_STATUS,
      headers: { 'content-type': 'text/html' },
    })
    expect(await restore(event)).toEqual(event.response)
  })

  it('changes no other status, and names only a status the stand-in is for', async () => {
    const ok = await restore(
      toViewerResponseEvent({ status: 200, headers: { [SERVER_STATUS_HEADER]: '404' } })
    )
    expect(ok.statusCode).toBe(200)
    expect(ok.headers?.[SERVER_STATUS_HEADER]).toBeUndefined()
    const other = await restore(
      toViewerResponseEvent({
        status: SERVER_STAND_IN_STATUS,
        headers: { [SERVER_STATUS_HEADER]: '200' },
      })
    )
    expect(other.statusCode).toBe(SERVER_STAND_IN_STATUS)
    expect(other.headers?.[SERVER_STATUS_HEADER]).toBeUndefined()
  })

  it('agrees with restoredServerStatus, the rule the AWS adapter reads its probe by', () => {
    expect(restoredServerStatus(300, '404')).toBe(404)
    expect(restoredServerStatus(300, '403')).toBe(403)
    expect(restoredServerStatus(300, null)).toBe(300)
    expect(restoredServerStatus(300, '500')).toBe(300)
    expect(restoredServerStatus(404, '403')).toBe(404)
  })
})

describe('deployable server status source', () => {
  it('is within the build budget, imports nothing and exports nothing', () => {
    expect(Buffer.byteLength(SERVER_STATUS_SOURCE)).toBeLessThanOrEqual(EDGE_FUNCTION_MAX_BYTES)
    expect(SERVER_STATUS_SOURCE).not.toMatch(/^(import|export)\b/m)
    expect(SERVER_STATUS_SOURCE).toMatch(/(^|[;}])async function handler\(/m)
    expect(buildReadableServerStatus()).toMatch(/^function handler\(event\)/m)
  })
})
