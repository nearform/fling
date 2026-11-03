import type { Comment, FormProgress, FormsConfig } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  errorTree,
  formsOfKind,
  hasKind,
  isPageResponse,
  myProgress,
  nextPending,
  progressLabel,
  progressMatrix,
  renderableSchema,
  responsesHref,
  responsesTo,
  siteProgress,
  splitPageResponses,
} from '../src/lib/forms'

const schema = { type: 'object', properties: { verdict: { type: 'string', title: 'Verdict' } } }

const config: FormsConfig = {
  title: 'Labels',
  forms: [
    {
      id: 'decision',
      title: 'Label this interview',
      kind: 'page',
      paths: ['**', '!pd-*/**'],
      visibility: 'own',
      schema,
    },
    {
      id: 'pd',
      title: 'Label this design',
      kind: 'page',
      paths: ['pd-*/**'],
      visibility: 'everyone',
      schema,
    },
    { id: 'issue', title: 'Report an issue', kind: 'comment', visibility: 'everyone', schema },
  ],
}

let n = 0
function comment(over: Omit<Partial<Comment>, 'author'> & { author?: string } = {}): Comment {
  const { author = 'me@example.test', ...rest } = over
  n++
  return {
    id: `c${n}`,
    parentId: null,
    path: '/',
    versionId: 'v1',
    anchor: null,
    body: 'text',
    author: { kind: 'user', email: author },
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`,
    resolvedAt: null,
    resolvedBy: null,
    canDelete: true,
    ...rest,
  }
}

const response = (formId: string, path: string, author = 'me@example.test', over = {}) =>
  comment({
    path,
    author,
    response: { formId, data: { verdict: 'pass' }, versionId: 'v1' },
    ...over,
  })

describe('forms on the review page', () => {
  it('links to the progress view', () => {
    expect(responsesHref('deck')).toBe('/sites/deck/responses')
  })

  it('shows the forms of one kind that apply to the page', () => {
    expect(formsOfKind(config, '/a.html', 'page').map(f => f.id)).toEqual(['decision'])
    expect(formsOfKind(config, '/pd-1/', 'page').map(f => f.id)).toEqual(['pd'])
    expect(formsOfKind(config, '/pd-1/', 'comment').map(f => f.id)).toEqual(['issue'])
    expect(formsOfKind(null, '/', 'page')).toEqual([])
    expect(hasKind(config, 'page')).toBe(true)
    expect(hasKind({ ...config, forms: config.forms.slice(2) }, 'page')).toBe(false)
    expect(hasKind(null, 'comment')).toBe(false)
  })

  it('tells page-kind responses from comments and comment-kind responses', () => {
    expect(isPageResponse(response('decision', '/'), config)).toBe(true)
    const pinned = { x: 1, y: 2 }
    expect(
      isPageResponse(response('issue', '/', 'me@example.test', { anchor: pinned }), config)
    ).toBe(false)
    expect(isPageResponse(comment(), config)).toBe(false)
    // A form the config no longer has: judged by its pin.
    expect(isPageResponse(response('gone', '/'), config)).toBe(true)
    expect(
      isPageResponse(response('gone', '/', 'me@example.test', { anchor: pinned }), config)
    ).toBe(false)
  })

  it('takes page-kind responses and their replies out of the threads', () => {
    const label = response('decision', '/')
    const reply = comment({ parentId: label.id })
    const plain = comment()
    const plainReply = comment({ parentId: plain.id })
    const issue = response('issue', '/', 'me@example.test', { anchor: { x: 1, y: 1 } })
    const split = splitPageResponses([label, reply, plain, plainReply, issue], config)
    expect(split.pageResponses).toEqual([label])
    expect(split.comments).toEqual([plain, plainReply, issue])
    // Without forms, nothing is taken out but pinless responses.
    expect(splitPageResponses([plain, plainReply], null).comments).toEqual([plain, plainReply])
  })

  it('finds my response to a form on a page, and the others', () => {
    const mine = response('decision', '/a.html')
    const theirs = response('decision', '/a.html', 'them@example.test')
    const elsewhere = response('decision', '/b.html')
    const all = [theirs, mine, elsewhere]
    expect(
      responsesTo(all, { formId: 'decision', path: '/a.html', email: 'me@example.test' })
    ).toEqual({
      mine,
      others: [theirs],
    })
    expect(
      responsesTo(all, { formId: 'decision', path: '/a.html', email: undefined }).mine
    ).toBeUndefined()
  })

  it('counts a page done when every page-kind form on it has my response', () => {
    const progress: FormProgress[] = [
      { form: 'decision', pages: ['/', '/a.html', '/b.html'], reviewers: [], done: {} },
      { form: 'extra', pages: ['/b.html'], reviewers: [], done: {} },
      { form: 'issue', pages: ['/', '/a.html', '/b.html', '/c.html'], reviewers: [], done: {} },
    ]
    const two: FormsConfig = {
      ...config,
      forms: [
        ...config.forms,
        { ...config.forms[0], id: 'extra', paths: ['b.html'] } as FormsConfig['forms'][number],
      ],
    }
    const responses = [
      response('decision', '/a.html'),
      response('decision', '/b.html'),
      response('decision', '/', 'them@example.test'),
    ]
    expect(myProgress(two, progress, responses, 'me@example.test')).toEqual({
      pages: ['/', '/a.html', '/b.html'],
      done: ['/a.html'],
      pending: ['/', '/b.html'],
    })
    expect(
      myProgress(two, progress, [...responses, response('extra', '/b.html')], 'me@example.test')
        .done
    ).toEqual(['/a.html', '/b.html'])
  })

  it('finds the next page waiting for my response, round to the start', () => {
    const pending = ['/a.html', '/c.html', '/e.html']
    expect(nextPending(pending, '/b.html')).toBe('/c.html')
    expect(nextPending(pending, '/c.html')).toBe('/e.html')
    expect(nextPending(pending, '/f.html')).toBe('/a.html')
    expect(nextPending(['/a.html'], '/a.html')).toBeNull()
    expect(nextPending([], '/')).toBeNull()
  })

  it('says progress after the config title', () => {
    expect(progressLabel('Labels', 12, 51)).toBe('Labels · 12 / 51')
  })

  it('lays out a page × reviewer matrix', () => {
    const p: FormProgress = {
      form: 'decision',
      pages: ['/', '/a.html'],
      reviewers: ['a@x.test', 'b@x.test'],
      done: { '/a.html': ['b@x.test'] },
    }
    expect(progressMatrix(p)).toEqual({
      reviewers: ['a@x.test', 'b@x.test'],
      rows: [
        { path: '/', done: [false, false], count: 0 },
        { path: '/a.html', done: [false, true], count: 1 },
      ],
      answered: 1,
    })
  })

  it("counts the site's pages where every page-kind form has a response", () => {
    const progress: FormProgress[] = [
      { form: 'decision', pages: ['/', '/a.html'], reviewers: ['x'], done: { '/': ['x'] } },
      { form: 'pd', pages: ['/pd-1/'], reviewers: [], done: {} },
      {
        form: 'issue',
        pages: ['/', '/a.html', '/pd-1/'],
        reviewers: ['x'],
        done: { '/a.html': ['x'] },
      },
    ]
    expect(siteProgress(config, progress)).toEqual({ done: 1, total: 3 })
    expect(siteProgress({ forms: config.forms.slice(2) }, progress)).toBeNull()
  })

  it("puts the server's field errors under their fields", () => {
    expect(
      errorTree([
        { field: 'verdict', message: 'is required' },
        { field: 'scores/clarity', message: 'must be ≤ 5' },
        { field: 'scores/clarity', message: 'must be an integer' },
        { field: '', message: 'too big' },
      ])
    ).toEqual({
      verdict: { __errors: ['is required'] },
      scores: { clarity: { __errors: ['must be ≤ 5', 'must be an integer'] } },
      __errors: ['too big'],
    })
  })

  it('gives choices without a type the type of their values, and drops the root title', () => {
    const out = renderableSchema({
      type: 'object',
      title: 'Shown elsewhere',
      properties: {
        verdict: { oneOf: [{ const: 'pass', title: 'Pass' }, { const: 'fail' }] },
        score: { enum: [1, 2, 3] },
        ratio: { enum: [1, 1.5] },
        mixed: { enum: ['a', 1] },
        tags: { type: 'array', items: { enum: ['x', 'y'] } },
        kept: { type: 'string', enum: ['a'] },
      },
    })
    expect(out.title).toBeUndefined()
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.verdict?.type).toBe('string')
    expect(props.score?.type).toBe('integer')
    expect(props.ratio?.type).toBe('number')
    expect(props.mixed?.type).toBeUndefined()
    expect(props.tags).toMatchObject({ items: { type: 'string' } })
    expect(props.kept).toEqual({ type: 'string', enum: ['a'] })
  })
})
