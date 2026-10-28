import { describe, expect, it } from 'vitest'
import {
  ACCESS_LEVELS,
  accessLevelOf,
  accessProblem,
  describeSiteAccess,
  parseAccessLevel,
  siteAccessLevel,
} from '../src/access.ts'
import { defaultAccessOf, InstanceMetadataSchema } from '../src/instance.ts'

const MEMBERS = 'anyone signed in to Fling (@example.test accounts)'

describe('access levels', () => {
  it('map from what is stored', () => {
    const level = (visibility: 'public' | 'private', restricted: boolean, emails = 0, groups = 0) =>
      accessLevelOf({ visibility, restricted, emails, groups })
    expect(level('public', true, 2)).toBe('public')
    expect(level('private', false)).toBe('members')
    expect(level('private', true)).toBe('only_me')
    expect(level('private', true, 0, 1)).toBe('groups')
    expect(level('private', true, 1, 1)).toBe('people')
  })

  it("derive a site's level when the server does not say it", () => {
    expect(siteAccessLevel({ visibility: 'private' })).toBe('members')
    expect(
      siteAccessLevel({
        visibility: 'private',
        restricted: true,
        audienceSize: 2,
        audienceGroups: 2,
      })
    ).toBe('groups')
    expect(siteAccessLevel({ access: 'only_me', visibility: 'private' })).toBe('only_me')
  })

  it('check the audience that goes with a level', () => {
    expect(accessProblem('people')).toMatch(/needs at least one/)
    expect(accessProblem('groups', { emails: [], groups: [] })).toMatch(/needs at least one/)
    expect(accessProblem('groups', { emails: ['a@x.test'] })).toBeNull()
    expect(accessProblem('only_me', { emails: [] })).toMatch(/takes no/)
    for (const level of ['only_me', 'members', 'public'] as const) {
      expect(accessProblem(level)).toBeNull()
    }
  })

  it('parse the names and their aliases', () => {
    for (const level of ACCESS_LEVELS) expect(parseAccessLevel(level)).toBe(level)
    expect(parseAccessLevel('only-me')).toBe('only_me')
    expect(parseAccessLevel('Only me')).toBe('only_me')
    expect(parseAccessLevel('teams')).toBe('groups')
    expect(parseAccessLevel('nobody')).toBeNull()
  })

  it('describe who can open a site', () => {
    const d = (site: object) =>
      describeSiteAccess({ visibility: 'private', ...site } as never, MEMBERS)
    expect(d({ access: 'only_me' })).toBe('Only you can open it.')
    expect(d({ access: 'only_me', shareUrl: 'https://s--x/' })).toMatch(/share link is active/)
    expect(d({ access: 'members' })).toBe(`${MEMBERS.replace(/^a/, 'A')} can open it.`)
    expect(d({ access: 'people', audienceSize: 3, audienceGroups: 1 })).toBe(
      'Only you and 2 people and 1 group can open it.'
    )
  })

  it('an instance says its default; older ones (and unknown values) mean members', () => {
    expect(defaultAccessOf({ defaultAccess: 'only_me' })).toBe('only_me')
    expect(defaultAccessOf({})).toBe('members')
    expect(defaultAccessOf(null)).toBe('members')
    const parsed = InstanceMetadataSchema.parse({
      version: 1,
      name: 'Fling',
      appOrigin: 'https://fling.example.test',
      sitesDomain: 'sites.example.test',
      siteScheme: 'https',
      auth: { kind: 'dev', displayName: 'Dev' },
      installCommand: 'npm i -g x',
      defaultAccess: 'someone_new',
    })
    expect(defaultAccessOf(parsed)).toBe('members')
  })
})
