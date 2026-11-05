import { describe, expect, it } from 'vitest'
import { checkPathsIndex, type PathListing, renderPathsIndex } from '../src/paths-index.ts'
import {
  isPathsTemplateName,
  PATHS_TEMPLATE_DESCRIPTIONS,
  PATHS_TEMPLATE_NAMES,
  pathsTemplate,
} from '../src/paths-templates.ts'

const PATHS: PathListing[] = [
  { folder: 'PAY-9', title: 'Checkout retry', updated: '2026-11-01T10:00:00Z', version: 'v1' },
  { folder: 'PAY-10', title: 'Refund flow', updated: '2026-11-05T09:30:00Z', version: 'v2' },
  { folder: 'PAY-412', title: '', updated: '2026-10-20T08:00:00Z', version: 'v3' },
]

describe.each(PATHS_TEMPLATE_NAMES)('the %s template', name => {
  it('is described and recognised', () => {
    expect(PATHS_TEMPLATE_DESCRIPTIONS[name]).toBeTruthy()
    expect(isPathsTemplateName(name)).toBe(true)
  })

  it('passes the check with no errors or warnings', () => {
    const r = checkPathsIndex(pathsTemplate(name))
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('is a complete page for light and dark', () => {
    const html = pathsTemplate(name)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).toContain('</html>')
  })

  it('renders with no Paths', () => {
    const { html } = renderPathsIndex(pathsTemplate(name), [])
    expect(html).not.toMatch(/fling:paths(?!-)|\{\{/)
    expect(html).not.toContain('data-fling-path ')
  })

  it('renders three Paths, each linked', () => {
    const { html } = renderPathsIndex(pathsTemplate(name), PATHS)
    expect(html.match(/data-fling-path /g)).toHaveLength(3)
    for (const p of PATHS) expect(html).toContain(`href="./${p.folder}/"`)
    expect(html).not.toMatch(/\{\{|fling:/)
  })

  it('takes a title, escaped', () => {
    const html = pathsTemplate(name, { title: ' Team <A> ' })
    expect(html).toContain('<title>Team &lt;A&gt;</title>')
  })
})

describe('isPathsTemplateName', () => {
  it('rejects other names', () => {
    expect(isPathsTemplateName('blog')).toBe(false)
  })
})
