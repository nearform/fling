import { MeSchema } from '@fling/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, isUnauthorized, request } from '../src/lib/api'
import { timeAgo } from '../src/lib/format'

function respond(status: number, body?: unknown) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const fetchMock = vi.fn(async () => new Response(text || null, { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const me = { email: 'a@nearform.com', name: 'A B', picture: null, userSlug: 'a' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request', () => {
  it('parses a successful response with the schema', async () => {
    respond(200, me)
    await expect(request('/api/me', MeSchema)).resolves.toEqual(me)
  })

  it('turns the error envelope into an ApiError with code and message', async () => {
    respond(409, { error: { code: 'name_taken', message: 'That name is taken' } })
    const error = await request('/api/sites/x', MeSchema).catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'name_taken', message: 'That name is taken' })
  })

  it('falls back to a synthetic code when the body is not an envelope', async () => {
    respond(502, '<html>Bad gateway</html>')
    await expect(request('/api/me', MeSchema)).rejects.toMatchObject({
      status: 502,
      code: 'http_502',
    })
  })

  it('reports a body that does not match the contract', async () => {
    respond(200, { email: 1 })
    await expect(request('/api/me', MeSchema)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('reports a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )
    await expect(request('/api/me', MeSchema)).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    })
  })

  it('sends JSON bodies with a content type', async () => {
    const fetchMock = respond(204)
    await api.setCurrentVersion('my app', 'v1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sites/my%20app/current',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ versionId: 'v1' }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    )
  })
})

describe('api.me', () => {
  it('returns null on 401 so the UI can show Login', async () => {
    respond(401, { error: { code: 'unauthorized', message: 'Sign in' } })
    await expect(api.me()).resolves.toBeNull()
  })

  it('rethrows other failures', async () => {
    respond(500, { error: { code: 'internal', message: 'Boom' } })
    const error = await api.me().catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(isUnauthorized(error)).toBe(false)
  })
})

describe('timeAgo', () => {
  it('formats relative times', () => {
    const now = Date.parse('2026-01-02T12:00:00Z')
    expect(timeAgo('2026-01-02T11:59:30Z', now)).toBe('just now')
    expect(timeAgo('2026-01-02T09:00:00Z', now)).toBe('3 hours ago')
    expect(timeAgo('2026-01-01T12:00:00Z', now)).toBe('yesterday')
  })
})

describe('oauth consent + connections', () => {
  it('approves a request and returns the redirect URL', async () => {
    const fetchMock = respond(200, {
      redirectUrl: 'https://claude.ai/api/mcp/auth_callback?code=x',
    })
    await expect(api.decideOAuthRequest('req1', true)).resolves.toBe(
      'https://claude.ai/api/mcp/auth_callback?code=x'
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/oauth/requests/req1/approve',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('lists connections', async () => {
    const c = {
      id: 'g1',
      clientName: 'Claude',
      clientHost: 'claude.ai',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: null,
    }
    respond(200, { connections: [c] })
    await expect(api.listConnections()).resolves.toEqual([c])
  })
})
