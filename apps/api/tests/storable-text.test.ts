/**
 * User strings that become parts of stored keys (file paths, a Path's folder, addresses) are
 * refused at admission with a 400 when they hold NUL or a lone surrogate, text no store keeps as
 * it is, so the Table never sees a key it would refuse (a 500).
 */
import {
  EmailInputSchema,
  isStorableText,
  isValidSitePath,
  normalizePathFolder,
} from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { api, createUser, file, setup } from './helpers.ts'

const ODD = ['a\ud800', '\udc00b', 'a\u0000b']

describe('storable text', () => {
  it('is any text but NUL and lone surrogates', () => {
    expect(isStorableText('plain é 😀 \u0001')).toBe(true)
    for (const s of ODD) expect(isStorableText(s)).toBe(false)
  })

  it('is what a site path, a folder and an address must be', () => {
    for (const s of ODD) {
      expect(isValidSitePath(`${s}.html`)).toBe(false)
      expect(normalizePathFolder(s)).toBeNull()
      expect(EmailInputSchema.safeParse(`${s}@example.test`).success).toBe(false)
    }
    expect(isValidSitePath('docs/😀.html')).toBe(true)
  })

  it('a deploy, a Path publish and an audience holding one are 400s', async () => {
    const env = setup()
    const { key } = await createUser(env)
    const deploy = (body: unknown) => api(env, key, 'POST', '/api/sites/hello/deploys', body)
    const page = file('index.html', '<h1>hi</h1>')
    for (const s of ODD) {
      const res = await deploy({ manifest: { files: [{ ...page.meta, path: `${s}.html` }] } })
      expect(res.status).toBe(400)
      const path = await deploy({ manifest: { files: [page.meta] }, path: s })
      expect(path.status).toBe(400)
    }
    expect((await deploy({ manifest: { files: [page.meta] } })).status).toBe(200)
    for (const s of ODD) {
      const res = await api(env, key, 'PATCH', '/api/sites/hello', {
        audience: { emails: [`${s}@example.test`] },
      })
      expect(res.status).toBe(400)
    }
  })
})
