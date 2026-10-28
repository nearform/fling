import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Comment, CommentList } from '../src/comments.ts'
import {
  describeComments,
  mcpRemoteInstructions,
  mcpTools,
  mcpToolsFor,
  mcpWording,
} from '../src/mcp-tools.ts'

describe('mcp tool catalogue', () => {
  const tools = Object.values(mcpTools)

  it('has unique fling_ names and non-empty descriptions', () => {
    const names = tools.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of tools) {
      expect(t.name).toMatch(/^fling_[a-z_]+$/)
      expect(t.description.length).toBeGreaterThan(20)
    }
  })

  it('steers Claude away from sandbox paths and towards confirming names', () => {
    expect(mcpTools.publish.description).toMatch(/never pass file paths from your sandbox/)
    expect(mcpTools.publish.description).toMatch(/confirm it with them/)
    expect(mcpRemoteInstructions(mcpWording())).toMatch(/fling_publish/)
  })

  it('renders descriptions from the instance, and stays generic without one', () => {
    const instance = {
      name: 'Acme Fling',
      sitesDomain: 'sites.example.test',
      siteScheme: 'https' as const,
      auth: {
        kind: 'oidc',
        issuer: 'https://sso.example.test',
        displayName: 'Example SSO',
        emailDomains: ['example.test'],
      },
    }
    const w = mcpWording(instance)
    const tools = mcpToolsFor(w)
    expect(tools.checkName.description).toContain('https://<name>.sites.example.test')
    expect(tools.setVisibility.description).toContain(
      'anyone signed in to Acme Fling (@example.test accounts)'
    )
    expect(tools.whoami.description).toBe('Show the signed-in user that Acme Fling acts as.')
    expect(mcpRemoteInstructions(w)).toMatch(
      /^Acme Fling publishes static sites .* at https:\/\/<name>\.sites\.example\.test\./
    )
    expect(mcpTools.checkName.description).toContain('https://<name>.<sites domain>')
    // The review page needs the app origin; without it the wording stays generic.
    expect(tools.commentsList.description).toContain('/review/<name>')
    const withOrigin = mcpToolsFor(
      mcpWording({ ...instance, appOrigin: 'https://fling.example.test' })
    )
    expect(withOrigin.commentAdd.description).toContain('https://fling.example.test/review/<name>')
    expect(mcpRemoteInstructions(w)).not.toContain('fling_comments_list')
    expect(mcpRemoteInstructions(w, { comments: true })).toContain('fling_comments_list')
    // Same names and schemas whatever the wording.
    expect(Object.keys(tools.publish.inputSchema)).toEqual(
      Object.keys(mcpTools.publish.inputSchema)
    )
  })

  it('words a personal instance (invited addresses only) naturally', () => {
    const w = mcpWording({
      name: 'My Fling',
      sitesDomain: 'sites.example.test',
      siteScheme: 'https',
      auth: { kind: 'oidc', displayName: 'Google', emailDomains: [], invitedEmails: true },
    })
    expect(mcpToolsFor(w).setVisibility.description).toBe(
      'Make a site private (open to anyone signed in to My Fling (invited accounts)) or public (anyone).'
    )
  })

  it('validates publish input', () => {
    const schema = z.object(mcpTools.publish.inputSchema)
    expect(
      schema.safeParse({ name: 'a', files: [{ path: 'index.html', content: 'x' }] }).success
    ).toBe(true)
    expect(schema.safeParse({ name: 'a', files: [] }).success).toBe(false)
    expect(
      schema.safeParse({
        name: 'a',
        files: [{ path: 'a', content: 'x', encoding: 'hex' }],
      }).success
    ).toBe(false)
    const del = z.object(mcpTools.delete.inputSchema)
    expect(del.safeParse({ name: 'a', confirm: false }).success).toBe(false)
  })
})

describe('describeComments', () => {
  const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
    id,
    parentId: null,
    path: '/',
    versionId: 'v2',
    anchor: null,
    body: `body ${id}`,
    author: { kind: 'user', email: 'a@example.test' },
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    canDelete: true,
    ...over,
  })
  const list: CommentList = {
    site: { name: 'deck', url: 'https://deck.example.test/', currentVersionId: 'v2' },
    comments: [
      comment('t1', { path: '/docs/', versionId: 'v1', body: 'two\nlines' }),
      comment('t2', { resolvedAt: '2026-01-02T00:00:00.000Z' }),
      comment('r1', { parentId: 't1', author: { kind: 'guest', name: 'Pat' } }),
    ],
    can: { create: true, resolve: true, deleteAny: true },
  }

  it('lists open threads with their replies; resolved ones on request', () => {
    expect(describeComments(list)).toBe(
      [
        '1 open thread on deck (1 resolved not shown)',
        '- [t1] /docs/, version v1 — a@example.test, 2026-01-01T00:00:00.000Z:',
        '  two',
        '  lines',
        '  - [r1] Pat (guest), 2026-01-01T00:00:00.000Z: body r1',
      ].join('\n')
    )
    expect(
      describeComments(list, { includeResolved: true, reviewUrl: 'https://x/review/deck' })
    ).toMatch(
      /^2 threads on deck\. Review page: https:\/\/x\/review\/deck\n[\s\S]*- \[t2\] RESOLVED \/, current version/
    )
  })
})
