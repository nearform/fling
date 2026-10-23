import { isValidSiteName, SITE_NAME_MAX } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { defaultSiteName, findProjectRoot, fitName } from '../src/naming.ts'

const HOME = '/Users/me'

/** A fake filesystem: the given paths exist (and nothing else). */
function env(...paths: string[]) {
  const set = new Set(paths)
  return { home: HOME, exists: (p: string) => set.has(p) }
}

describe('findProjectRoot', () => {
  it('prefers the nearest .git, then the nearest package manifest, and stops below home', () => {
    const e = env('/Users/me/work/mono/.git', '/Users/me/work/mono/packages/ui/package.json')
    expect(findProjectRoot('/Users/me/work/mono/packages/ui/dist', e)).toBe('/Users/me/work/mono')
    expect(findProjectRoot('/Users/me/work/x/dist', env('/Users/me/work/x/Cargo.toml'))).toBe(
      '/Users/me/work/x'
    )
    expect(findProjectRoot('/Users/me/Downloads/report', env('/Users/me/.git'))).toBeNull()
    expect(findProjectRoot('/tmp/x/build', env('/.git'))).toBeNull()
  })
})

describe('defaultSiteName', () => {
  const git = (root: string) => env(`${root}/.git`)

  it.each<[string, string, ReturnType<typeof env>]>([
    ['/Users/me/work/rocketpod/docs', 'rocketpod-docs', git('/Users/me/work/rocketpod')],
    ['/Users/me/work/myapp/dist', 'myapp', git('/Users/me/work/myapp')],
    ['/Users/me/work/myapp', 'myapp', git('/Users/me/work/myapp')],
    ['/Users/me/work/mono/apps/web/dist', 'mono-web', git('/Users/me/work/mono')],
    [
      '/Users/me/work/mono/packages/ui/storybook-static',
      'mono-ui-storybook',
      git('/Users/me/work/mono'),
    ],
    ['/Users/me/work/site/public', 'site', git('/Users/me/work/site')],
    ['/Users/me/Downloads/report', 'report', env()],
    ['/Users/me/Downloads/report/dist', 'report', env()],
    ['/tmp/x/build', 'x', env()],
    // package.json root when there is no .git
    ['/Users/me/work/tool/out', 'tool', env('/Users/me/work/tool/package.json')],
    // duplicates collapse; dot dirs (.vitepress) are skipped
    [
      '/Users/me/work/rocketpod/docs/docs/.vitepress/dist',
      'rocketpod-docs',
      git('/Users/me/work/rocketpod'),
    ],
    ['/Users/me/work/blog/blog/_site', 'blog', git('/Users/me/work/blog')],
    // slugified
    [
      '/Users/me/work/My Cool App/src/Landing Page',
      'my-cool-app-landing-page',
      git('/Users/me/work/My Cool App'),
    ],
  ])('%s → %s', (dir, expected, e) => {
    expect(defaultSiteName(dir, e)).toBe(expected)
  })

  it('never includes the user name, even for folders right under home', () => {
    expect(defaultSiteName('/Users/me/dist', env())).toBe('dist')
    expect(defaultSiteName('/Users/me', env())).toBe('my-site')
    expect(defaultSiteName('/Users/me/project', env())).toBe('project')
  })
})

describe('fitName', () => {
  it('drops middle parts before truncating, and never ends with a hyphen', () => {
    const long = 'a'.repeat(20)
    const name = fitName(['root', long, long, 'leaf'])
    expect(name).toBe(`root-${long}-leaf`)
    const huge = fitName(['x'.repeat(30), 'y'.repeat(30)])
    expect(huge.length).toBeLessThanOrEqual(SITE_NAME_MAX)
    expect(huge.endsWith('-')).toBe(false)
    expect(isValidSiteName(fitName(['abc', `${'z'.repeat(46)}-q`]))).toBe(true)
  })

  it('appends -site to reserved names and falls back for empty ones', () => {
    expect(fitName(['api'])).toBe('api-site')
    expect(fitName(['fling'])).toBe('fling-site')
    expect(fitName(['***'])).toBe('my-site')
    expect(fitName([])).toBe('my-site')
  })
})
