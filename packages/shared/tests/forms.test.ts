import { describe, expect, it } from 'vitest'
import { DeployRequestSchema } from '../src/api.ts'
import { CreateCommentRequestSchema, RESPONSE_DATA_MAX_BYTES } from '../src/comments.ts'
import {
  checkFormSchema,
  checkFormsConfig,
  FORMS_MAX,
  type FormsConfig,
  FormsConfigSchema,
  formProgress,
  formsForPath,
  formsSummaryLines,
  type ResponseRow,
  responseFields,
  responseSummary,
  responsesCsv,
  responsesFileName,
  responsesJsonl,
  reviewPages,
  validateResponse,
} from '../src/forms.ts'
import { FORM_TEMPLATE_NAMES, formsTemplate } from '../src/forms-templates.ts'

const decision = {
  id: 'decision',
  title: 'Label this interview',
  kind: 'page',
  paths: ['**', '!pd-*/**'],
  visibility: 'own',
  schema: {
    type: 'object',
    required: ['verdict'],
    properties: {
      verdict: {
        title: 'Verdict',
        oneOf: [
          { const: 'pass', title: 'Pass: the interviewer handled it' },
          { const: 'fail', title: 'Fail' },
        ],
      },
      notes: { type: 'string', title: 'Notes' },
    },
  },
  uiSchema: { verdict: { 'ui:widget': 'radio' } },
} as const

const config = (forms: unknown[] = [decision], title = 'Labels') =>
  FormsConfigSchema.parse({ title, forms })

describe('FormsConfigSchema', () => {
  it('reads a config and fills in the defaults', () => {
    const parsed = config([{ id: 'a', title: 'A', schema: { type: 'object' } }])
    expect(parsed.forms[0]).toMatchObject({ kind: 'page', visibility: 'everyone' })
  })

  it('needs a title of at most 40 characters', () => {
    expect(FormsConfigSchema.safeParse({ forms: [decision] }).success).toBe(false)
    expect(FormsConfigSchema.safeParse({ title: 'x'.repeat(41), forms: [decision] }).success).toBe(
      false
    )
  })

  it('refuses duplicate ids, too many forms and bad globs', () => {
    expect(FormsConfigSchema.safeParse({ title: 'T', forms: [decision, decision] }).success).toBe(
      false
    )
    const many = Array.from({ length: FORMS_MAX + 1 }, (_, i) => ({ ...decision, id: `f${i}` }))
    expect(FormsConfigSchema.safeParse({ title: 'T', forms: many }).success).toBe(false)
    for (const glob of ['', '!', 'a b', 'a/!b', '../x']) {
      const form = { ...decision, paths: [glob] }
      expect(FormsConfigSchema.safeParse({ title: 'T', forms: [form] }).success, glob).toBe(false)
    }
  })

  it('travels in a deploy request, and null removes the forms', () => {
    const manifest = {
      files: [{ path: 'index.html', sha256: 'a'.repeat(64), size: 1, contentType: 'text/html' }],
    }
    expect(
      DeployRequestSchema.parse({ manifest, forms: { title: 'T', forms: [decision] } }).forms?.title
    ).toBe('T')
    expect(DeployRequestSchema.parse({ manifest, forms: null }).forms).toBeNull()
    expect(
      DeployRequestSchema.safeParse({ manifest, forms: { title: 'T', forms: [] } }).success
    ).toBe(false)
  })
})

describe('checkFormSchema', () => {
  it('accepts a 2020-12 object schema with local refs', () => {
    expect(
      checkFormSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { a: { $ref: '#/$defs/score' }, b: { $ref: '#s' } },
        $defs: { score: { type: 'integer', minimum: 1 }, s: { $anchor: 's', type: 'string' } },
      })
    ).toEqual([])
  })

  it('refuses a root that is not an object schema', () => {
    expect(checkFormSchema({ type: 'string' })).not.toEqual([])
    expect(checkFormSchema([])).not.toEqual([])
  })

  it('refuses what the metaschema refuses', () => {
    expect(checkFormSchema({ type: 'object', properties: { a: { type: 'text' } } })).not.toEqual([])
    expect(checkFormSchema({ type: 'object', required: 'a' })).not.toEqual([])
    expect(checkFormSchema({ type: 'object', properties: { a: { minLength: -1 } } })).not.toEqual(
      []
    )
  })

  it('refuses remote and dangling refs, and other drafts', () => {
    const remote = checkFormSchema({
      type: 'object',
      properties: { a: { $ref: 'https://example.test/schema.json' } },
    })
    expect(remote.join()).toMatch(/remote/)
    expect(
      checkFormSchema({ type: 'object', properties: { a: { $ref: '#/$defs/missing' } } }).join()
    ).toMatch(/points at nothing/)
    expect(
      checkFormSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' })
    ).not.toEqual([])
  })

  it('takes a "$ref" inside data keywords as data', () => {
    expect(
      checkFormSchema({ type: 'object', properties: { a: { const: { $ref: 'https://x.test' } } } })
    ).toEqual([])
  })
})

describe('validateResponse', () => {
  const form = config().forms[0] as FormsConfig['forms'][number]

  it('accepts data that fits', () => {
    expect(validateResponse(form, { verdict: 'pass', notes: 'fine' })).toEqual({ ok: true })
  })

  it('says what is wrong with each field', () => {
    const result = validateResponse(form, { verdict: 'maybe', notes: 3 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContainEqual({
      field: 'verdict',
      message: 'must be one of: Pass: the interviewer handled it, Fail',
    })
    expect(result.errors.find(e => e.field === 'notes')).toBeDefined()
    expect(validateResponse(form, {})).toEqual({
      ok: false,
      errors: [{ field: 'verdict', message: 'is required' }],
    })
  })

  it('limits the data a response request carries', () => {
    const big = { notes: 'x'.repeat(RESPONSE_DATA_MAX_BYTES) }
    expect(
      CreateCommentRequestSchema.safeParse({ response: { formId: 'decision', data: big } }).success
    ).toBe(false)
    expect(CreateCommentRequestSchema.safeParse({}).success).toBe(false)
    expect(
      CreateCommentRequestSchema.safeParse({ response: { formId: 'decision', data: {} } }).success
    ).toBe(true)
  })
})

describe('formsForPath', () => {
  const forms = config([
    decision,
    { ...decision, id: 'pd', paths: ['pd-*/**'] },
    { ...decision, id: 'docs', paths: ['docs'] },
    { ...decision, id: 'all', paths: undefined },
    { ...decision, id: 'html', paths: ['*.html', '!secret.html'] },
  ])
  const ids = (path: string) => formsForPath(forms, path).map(f => f.id)

  it('matches globs with exclusions on review paths', () => {
    // The home page is also `index.html`.
    expect(ids('/')).toEqual(['decision', 'all', 'html'])
    expect(ids('/pd-1/')).toEqual(['pd', 'all'])
    expect(ids('/pd-1/notes.html')).toEqual(['pd', 'all'])
    expect(ids('/about.html')).toEqual(['decision', 'all', 'html'])
    expect(ids('/secret.html')).toEqual(['decision', 'all'])
    expect(ids('/docs/index.html')).toEqual(['decision', 'docs', 'all'])
    expect(ids('/docs/a/b.html')).toEqual(['decision', 'all'])
  })

  it('normalises the path and has nothing without a config', () => {
    expect(ids('pd-2/index.html')).toEqual(['pd', 'all'])
    expect(formsForPath(null, '/')).toEqual([])
  })

  it('finds the pages among a site’s files', () => {
    expect(reviewPages(['index.html', 'docs/index.html', 'a.html', 'app.js', '/b/'])).toEqual([
      '/',
      '/a.html',
      '/b/',
      '/docs/',
    ])
  })
})

describe('checkFormsConfig', () => {
  it('summarises the pages each form applies to and warns about globs that match none', () => {
    const files = ['index.html', 'pd-1/index.html', 'interview-2.html', 'style.css']
    const check = checkFormsConfig(
      { title: 'Labels', forms: [decision, { ...decision, id: 'x', paths: ['nowhere/**'] }] },
      files
    )
    expect(check.ok).toBe(true)
    expect(check.summary?.forms[0]?.pages).toEqual(['/', '/interview-2.html'])
    expect(check.summary?.warnings).toEqual([
      'x: "nowhere/**" matches no page',
      'x: applies to no page',
    ])
    expect(formsSummaryLines(check.summary as never)[0]).toMatch(/^Labels · Label this interview/)
  })

  it('lists the errors with where they are', () => {
    const check = checkFormsConfig({
      title: 'T',
      forms: [{ ...decision, schema: { type: 'object', properties: { a: { $ref: 'http://x' } } } }],
    })
    expect(check.ok).toBe(false)
    expect(check.errors[0]).toMatch(/^forms\.0\.schema: /)
    expect(check.summary).toBeNull()
  })

  it('passes every template', () => {
    for (const name of FORM_TEMPLATE_NAMES) {
      const check = checkFormsConfig(formsTemplate(name))
      expect(check.errors, name).toEqual([])
    }
    expect(formsTemplate('labels', 'Evals').title).toBe('Evals')
  })
})

describe('responses', () => {
  const form = config().forms[0] as FormsConfig['forms'][number]

  it('summarise with the schema’s titles', () => {
    expect(responseFields(form, { notes: 'n', verdict: 'pass' })).toEqual([
      { key: 'verdict', label: 'Verdict', value: 'Pass: the interviewer handled it' },
      { key: 'notes', label: 'Notes', value: 'n' },
    ])
    expect(responseSummary(form, { verdict: 'fail' })).toBe('Label this interview\nVerdict: Fail')
  })

  const row = (over: Partial<ResponseRow>): ResponseRow => ({
    id: 'R1',
    path: '/',
    formId: 'decision',
    author: 'a@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    versionId: 'v1',
    data: { verdict: 'pass' },
    ...over,
  })

  it('export as CSV with a column per answer, and as JSON Lines', () => {
    const rows = [
      row({}),
      row({ id: 'R2', data: { verdict: 'fail', notes: 'a, "b"', extra: { x: 1 } } }),
    ]
    const csv = responsesCsv(rows, [form]).split('\r\n')
    expect(csv[0]).toBe('id,path,formId,author,createdAt,updatedAt,versionId,verdict,notes,extra')
    expect(csv[2]).toMatch(/,fail,"a, ""b""","{""x"":1}"$/)
    expect(
      responsesJsonl(rows)
        .trim()
        .split('\n')
        .map(l => JSON.parse(l).id)
    ).toEqual(['R1', 'R2'])
    expect(responsesFileName('site', 'My Labels!', 'csv')).toBe('site-my-labels.csv')
  })

  it('show progress per page and reviewer', () => {
    const rows = [row({}), row({ author: 'b@example.test' }), row({ path: '/x.html' })]
    expect(formProgress(form, ['/', '/x.html', '/pd-1/'], rows)).toEqual({
      form: 'decision',
      pages: ['/', '/x.html'],
      reviewers: ['a@example.test', 'b@example.test'],
      done: { '/': ['a@example.test', 'b@example.test'], '/x.html': ['a@example.test'] },
    })
  })
})
