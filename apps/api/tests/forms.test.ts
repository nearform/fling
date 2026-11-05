/**
 * Forms through the API: the config a deploy carries (kept by a publish on a base, removed with null,
 * returned by pull), `GET …/forms`, responses submitted as comments (page kind: one per reviewer
 * per page; comment kind: a thread), what is refused, `own` visibility, and the export with its
 * progress, as JSON, JSON Lines and CSV.
 */
import type { FormsConfigInput } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { formsKey } from '../src/blobs/types.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

type F = ReturnType<typeof file>

const pages = [
  file('index.html', '<h1>home</h1>'),
  file('interview-1.html', '<h1>one</h1>'),
  file('interview-2.html', '<h1>two</h1>'),
  file('pd-1/index.html', '<h1>pd</h1>'),
  file('style.css', 'h1{}', 'text/css'),
]

const FORMS: FormsConfigInput = {
  title: 'Labels',
  forms: [
    {
      id: 'decision',
      title: 'Label this interview',
      kind: 'page',
      paths: ['interview-*.html'],
      visibility: 'own',
      schema: {
        type: 'object',
        required: ['verdict'],
        properties: {
          verdict: {
            title: 'Verdict',
            oneOf: [
              { const: 'pass', title: 'Pass' },
              { const: 'fail', title: 'Fail' },
            ],
          },
          notes: { type: 'string', title: 'Notes' },
        },
      },
    },
    {
      id: 'issue',
      title: 'Flag an issue',
      kind: 'comment',
      schema: {
        type: 'object',
        required: ['severity'],
        properties: { severity: { enum: ['major', 'minor'] } },
      },
    },
  ],
}

async function deploy(env: Env, key: string, name: string, files: F[], extra: object = {}) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  if (res.status !== 200 || body.status !== 'upload') return { status: res.status, body }
  await upload(env, body.uploads, files)
  const done = await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
  return { status: done.status, body: await json(done) }
}

async function world(overrides = {}) {
  const env = setup(overrides)
  const alice = await createUser(env, 'alice@example.test')
  const bob = await createUser(env, 'bob@example.test')
  const carol = await createUser(env, 'carol@example.test')
  const live = await deploy(env, alice.key, 'evals', pages, { access: 'members', forms: FORMS })
  expect(live.status).toBe(200)
  return { env, alice, bob, carol, v1: live.body.versionId as string }
}

const respond = (env: Env, key: string, body: object) =>
  api(env, key, 'POST', '/api/sites/evals/comments', body)
const responses = async (env: Env, key: string, query = '') =>
  api(env, key, 'GET', `/api/sites/evals/responses${query}`)
const comments = async (env: Env, key: string) =>
  json(await api(env, key, 'GET', '/api/sites/evals/comments'))

describe('the forms config', () => {
  it('comes with the live version, for one page or all of them', async () => {
    const { env, bob, v1 } = await world()
    const all = await json(await api(env, bob.key, 'GET', '/api/sites/evals/forms'))
    expect(all.versionId).toBe(v1)
    expect(all.config.title).toBe('Labels')
    expect(all.forms.map((f: { id: string }) => f.id)).toEqual(['decision', 'issue'])
    const one = await json(
      await api(env, bob.key, 'GET', '/api/sites/evals/forms?path=/interview-1.html')
    )
    expect(one).toMatchObject({ path: '/interview-1.html' })
    expect(one.forms.map((f: { id: string }) => f.id)).toEqual(['decision', 'issue'])
    const home = await json(await api(env, bob.key, 'GET', '/api/sites/evals/forms?path=/'))
    expect(home.forms.map((f: { id: string }) => f.id)).toEqual(['issue'])
  })

  it('is refused when a schema is not valid or has a remote $ref', async () => {
    const env = setup()
    const alice = await createUser(env, 'alice@example.test')
    const bad = {
      title: 'T',
      forms: [
        {
          id: 'a',
          title: 'A',
          schema: { type: 'object', properties: { x: { $ref: 'https://x.test/s.json' } } },
        },
      ],
    }
    const res = await deploy(env, alice.key, 'bad', pages, { forms: bad })
    expect(res.status).toBe(400)
    expect(await env.store.findSite('bad')).toBeNull()
  })

  it('is kept by a publish on a base, replaced when sent, and removed with null', async () => {
    const { env, alice, v1 } = await world()
    const site = await env.store.findSite('evals')
    const id = site?.id as string
    const week = await deploy(env, alice.key, 'evals', [file('w/week/index.html', '<h1>w</h1>')], {
      base: v1,
      partial: true,
    })
    expect(week.status).toBe(200)
    expect(week.body.versionId).not.toBe(v1)
    expect(
      (await env.blobs.getJson<{ title: string }>(formsKey(id, week.body.versionId)))?.title
    ).toBe('Labels')

    const renamed = await deploy(
      env,
      alice.key,
      'evals',
      [file('w/week/index.html', '<h1>w2</h1>')],
      {
        base: week.body.versionId,
        partial: true,
        forms: { ...FORMS, title: 'Evals' },
      }
    )
    expect(
      (await env.blobs.getJson<{ title: string }>(formsKey(id, renamed.body.versionId)))?.title
    ).toBe('Evals')

    // The same files with `forms: null`: unchanged, and the live version has no forms now.
    const same = await api(env, alice.key, 'POST', '/api/sites/evals/deploys', {
      manifest: { files: [file('w/week/index.html', '<h1>w2</h1>').meta] },
      base: renamed.body.versionId,
      partial: true,
      forms: null,
    })
    expect((await json(same)).status).toBe('unchanged')
    const now = await json(await api(env, alice.key, 'GET', '/api/sites/evals/forms'))
    expect(now).toMatchObject({ config: null, forms: [] })
  })

  it('a whole deploy without forms has none', async () => {
    const { env, alice } = await world()
    await deploy(env, alice.key, 'evals', [file('index.html', '<h1>new</h1>')])
    const now = await json(await api(env, alice.key, 'GET', '/api/sites/evals/forms'))
    expect(now.config).toBeNull()
  })

  it('comes with a pull', async () => {
    const { env, bob } = await world()
    const pulled = await json(await api(env, bob.key, 'GET', '/api/sites/evals/pull'))
    expect(pulled.forms.title).toBe('Labels')
    expect(pulled.files.map((f: { path: string }) => f.path)).not.toContain('fling.forms.json')
  })

  it('is scanned for secrets', async () => {
    const env = setup()
    const alice = await createUser(env, 'alice@example.test')
    const leaky = {
      ...FORMS,
      title: 'Leaky',
      forms: [{ ...FORMS.forms[1], title: `AKIA${'Q'.repeat(16)}` }],
    }
    const res = await deploy(env, alice.key, 'leaky', pages, { forms: leaky })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('secret_detected')
  })
})

describe('responses', () => {
  it('a page-kind response answered twice is one row, changed in place', async () => {
    const { env, bob, v1 } = await world()
    const first = await respond(env, bob.key, {
      path: '/interview-1.html',
      response: { formId: 'decision', data: { verdict: 'pass' } },
    })
    expect(first.status).toBe(201)
    const created = await json(first)
    expect(created).toMatchObject({
      path: '/interview-1.html',
      parentId: null,
      anchor: null,
      body: 'Label this interview\nVerdict: Pass',
      response: { formId: 'decision', data: { verdict: 'pass' }, versionId: v1 },
    })
    expect(created.id).toMatch(/^R[0-9a-f]{24}$/)
    env.advance(1000)
    const again = await json(
      await respond(env, bob.key, {
        path: 'interview-1.html',
        response: { formId: 'decision', data: { verdict: 'fail', notes: 'missed it' } },
      })
    )
    expect(again.id).toBe(created.id)
    expect(again.createdAt).toBe(created.createdAt)
    expect(again.updatedAt).not.toBe(created.createdAt)
    expect(again.body).toBe('Label this interview\nVerdict: Fail\nNotes: missed it')
    const listed = (await comments(env, bob.key)).comments
    expect(listed).toHaveLength(1)
    expect(listed[0].response.data).toEqual({ verdict: 'fail', notes: 'missed it' })
  })

  it('a comment-kind response is a new pinned thread each time, and can be replied to', async () => {
    const { env, alice, bob } = await world()
    const body = {
      path: '/',
      anchor: { x: 1, y: 2 },
      response: { formId: 'issue', data: { severity: 'major' } },
    }
    const a = await json(await respond(env, bob.key, body))
    const b = await json(await respond(env, bob.key, body))
    expect(a.id).not.toBe(b.id)
    expect(a.anchor).toEqual({ x: 1, y: 2 })
    const reply = await respond(env, alice.key, { body: 'On it', parentId: a.id })
    expect(reply.status).toBe(201)
    expect((await comments(env, alice.key)).comments).toHaveLength(3)
  })

  it('refuses the wrong form, page or kind, and data that does not fit', async () => {
    const { env, bob } = await world()
    const status = async (body: object) => {
      const res = await respond(env, bob.key, body)
      return [res.status, (await json(res)).error.code]
    }
    expect(await status({ path: '/', response: { formId: 'nope', data: {} } })).toEqual([
      400,
      'unknown_form',
    ])
    // decision applies to interview pages only.
    expect(
      await status({ path: '/', response: { formId: 'decision', data: { verdict: 'pass' } } })
    ).toEqual([400, 'unknown_form'])
    expect(
      await status({
        path: '/interview-1.html',
        anchor: { x: 1, y: 1 },
        response: { formId: 'decision', data: { verdict: 'pass' } },
      })
    ).toEqual([400, 'invalid_response'])
    const thread = await json(
      await respond(env, bob.key, { body: 'hi', path: '/interview-1.html' })
    )
    expect(
      await status({
        parentId: thread.id,
        response: { formId: 'issue', data: { severity: 'minor' } },
      })
    ).toEqual([400, 'invalid_response'])
    const bad = await respond(env, bob.key, {
      path: '/interview-1.html',
      response: { formId: 'decision', data: { verdict: 'maybe' } },
    })
    expect(bad.status).toBe(400)
    const error = (await json(bad)).error
    expect(error.code).toBe('invalid_response')
    expect(error.errors).toEqual([{ field: 'verdict', message: 'must be one of: Pass, Fail' }])
  })

  it('on an own form, reviewers see only theirs; the owner sees everyone’s', async () => {
    const { env, alice, bob, carol } = await world()
    for (const who of [bob, carol]) {
      await respond(env, who.key, {
        path: '/interview-1.html',
        response: { formId: 'decision', data: { verdict: 'pass' } },
      })
    }
    await respond(env, carol.key, {
      path: '/',
      response: { formId: 'issue', data: { severity: 'minor' } },
    })
    const authors = (list: { author: { email: string } }[]) => list.map(c => c.author.email).sort()
    expect(authors((await comments(env, bob.key)).comments)).toEqual([
      'bob@example.test',
      'carol@example.test',
    ])
    expect(authors((await comments(env, alice.key)).comments)).toEqual([
      'bob@example.test',
      'carol@example.test',
      'carol@example.test',
    ])
    const asBob = await json(await responses(env, bob.key, '?form=decision'))
    expect(asBob.responses.map((r: { author: string }) => r.author)).toEqual(['bob@example.test'])
    const asAlice = await json(await responses(env, alice.key, '?form=decision'))
    expect(asAlice.responses).toHaveLength(2)

    // Someone else's hidden response is missing to Bob, even by id.
    const carols = (await comments(env, alice.key)).comments.find(
      (c: { author: { email: string }; response?: { formId: string } }) =>
        c.author.email === 'carol@example.test' && c.response?.formId === 'decision'
    )
    const resolve = await api(env, bob.key, 'PATCH', `/api/sites/evals/comments/${carols.id}`, {
      resolved: true,
    })
    expect(resolve.status).toBe(404)
  })

  it('export as JSON with progress, as JSON Lines and as CSV', async () => {
    const { env, alice, bob, carol, v1 } = await world()
    await respond(env, bob.key, {
      path: '/interview-1.html',
      response: { formId: 'decision', data: { verdict: 'pass', notes: 'good, "very"' } },
    })
    env.advance(1000)
    await respond(env, carol.key, {
      path: '/interview-2.html',
      response: { formId: 'decision', data: { verdict: 'fail' } },
    })
    await respond(env, bob.key, { body: 'a plain comment', path: '/' })

    const exported = await json(await responses(env, alice.key))
    expect(exported.site).toEqual({ name: 'evals', currentVersionId: v1 })
    expect(exported.title).toBe('Labels')
    expect(exported.responses.map((r: { author: string }) => r.author)).toEqual([
      'bob@example.test',
      'carol@example.test',
    ])
    expect(exported.responses[0]).toMatchObject({
      path: '/interview-1.html',
      formId: 'decision',
      versionId: v1,
      data: { verdict: 'pass' },
    })
    const progress = exported.progress.find((p: { form: string }) => p.form === 'decision')
    expect(progress).toEqual({
      form: 'decision',
      pages: ['/interview-1.html', '/interview-2.html'],
      reviewers: ['bob@example.test', 'carol@example.test'],
      done: {
        '/interview-1.html': ['bob@example.test'],
        '/interview-2.html': ['carol@example.test'],
      },
    })

    const jsonl = await responses(env, alice.key, '?format=jsonl&form=decision')
    expect(jsonl.headers.get('content-type')).toMatch(/ndjson/)
    const lines = (await jsonl.text()).trim().split('\n')
    expect(lines.map(l => JSON.parse(l).author)).toEqual(['bob@example.test', 'carol@example.test'])

    const csv = await responses(env, alice.key, '?format=csv&form=decision&path=/interview-1.html')
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/)
    expect(csv.headers.get('content-disposition')).toContain('evals-labels.csv')
    const rows = (await csv.text()).trim().split('\r\n')
    expect(rows[0]).toBe('id,path,formId,author,createdAt,updatedAt,versionId,verdict,notes')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatch(/,pass,"good, ""very"""$/)

    expect((await responses(env, alice.key, '?format=xml')).status).toBe(400)
  })

  it('are off with comments, and the capability says so', async () => {
    const env = setup({ comments: false })
    const alice = await createUser(env, 'alice@example.test')
    expect((await api(env, alice.key, 'GET', '/api/sites/x/forms')).status).toBe(404)
    const meta = await json(await env.app.request('/.well-known/fling'))
    expect(meta.capabilities.forms).toBe(false)
    const on = await json(await setup().app.request('/.well-known/fling'))
    expect(on.capabilities.forms).toBe(true)
  })
})
