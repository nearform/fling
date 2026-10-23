import { describe, expect, it } from 'vitest'
import { type RouteOptions, routeArgs } from '../src/route.ts'

const opts = (paths: string[] = []): RouteOptions => ({
  commands: new Set(['deploy', 'ls', 'list', 'setup', 'help']),
  valueFlags: new Set(['--server', '-n', '--name']),
  exists: async p => paths.includes(p),
})

describe('routeArgs', () => {
  it('no arguments (or only options) → help', async () => {
    expect(await routeArgs([], opts())).toEqual({ kind: 'help' })
    expect(await routeArgs(['--json', '--server', 'http://x'], opts())).toEqual({ kind: 'help' })
  })

  it('an existing path deploys, options and all', async () => {
    expect(await routeArgs(['./dist', '--name', 'a'], opts(['./dist']))).toEqual({
      kind: 'run',
      args: ['deploy', './dist', '--name', 'a'],
    })
    // a value-taking flag's value is not mistaken for the path
    expect(await routeArgs(['--name', 'ls', './dist'], opts(['./dist']))).toEqual({
      kind: 'run',
      args: ['deploy', '--name', 'ls', './dist'],
    })
  })

  it('a path wins over a command of the same name', async () => {
    expect(await routeArgs(['ls'], opts(['ls']))).toEqual({ kind: 'run', args: ['deploy', 'ls'] })
  })

  it('commands and aliases run as given', async () => {
    expect(await routeArgs(['list', '--archived'], opts())).toEqual({
      kind: 'run',
      args: ['list', '--archived'],
    })
    expect(await routeArgs(['deploy', 'missing'], opts())).toEqual({
      kind: 'run',
      args: ['deploy', 'missing'],
    })
  })

  it('anything else is unknown; --help / --version pass through', async () => {
    expect(await routeArgs(['nope.html'], opts())).toEqual({ kind: 'unknown', arg: 'nope.html' })
    expect(await routeArgs(['--help'], opts())).toEqual({ kind: 'run', args: ['--help'] })
    expect(await routeArgs(['-V'], opts())).toEqual({ kind: 'run', args: ['-V'] })
  })
})
