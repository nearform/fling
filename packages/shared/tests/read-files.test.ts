import { describe, expect, it } from 'vitest'
import { encodeForAgent, pageOfFiles } from '../src/read-files.ts'

const f = (path: string, size: number) => ({ path, size })

describe('pageOfFiles', () => {
  const files = [f('a', 4), f('b', 4), f('big', 20), f('c', 4)]

  it('fills the budget in order, with a cursor for the rest; one too large is listed apart', () => {
    const first = pageOfFiles(files, { budget: 10 })
    expect(first.page.map(x => x.path)).toEqual(['a', 'b'])
    expect(first.tooLarge.map(x => x.path)).toEqual(['big'])
    expect(first.nextCursor).toBe('3')
    const next = pageOfFiles(files, { budget: 10, cursor: first.nextCursor })
    expect(next.page.map(x => x.path)).toEqual(['c'])
    expect(next.tooLarge).toEqual([])
    expect(next.nextCursor).toBeUndefined()
  })

  it('keeps to the paths asked for and says which are missing', () => {
    const page = pageOfFiles(files, { budget: 10, paths: ['c', 'nope'] })
    expect(page.page.map(x => x.path)).toEqual(['c'])
    expect(page.missing).toEqual(['nope'])
  })
})

describe('encodeForAgent', () => {
  it('text as utf8; binary, and text that is not UTF-8, as base64', () => {
    expect(encodeForAgent('a.html', new TextEncoder().encode('<p>é</p>'))).toEqual({
      encoding: 'utf8',
      content: '<p>é</p>',
    })
    const png = new Uint8Array([137, 80, 78, 71])
    expect(encodeForAgent('a.png', png)).toEqual({
      encoding: 'base64',
      content: Buffer.from(png).toString('base64'),
    })
    expect(encodeForAgent('a.txt', new Uint8Array([0xff, 0xfe, 0x41])).encoding).toBe('base64')
  })
})
