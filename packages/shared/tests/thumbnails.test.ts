import { describe, expect, it } from 'vitest'
import { isPreviewMode, previewShellUrl } from '../src/review-bridge.ts'
import {
  pngSize,
  THUMBNAIL_MAX_BYTES,
  thumbnailProblem,
  thumbnailUrl,
  wantsThumbnail,
} from '../src/thumbnails.ts'

/** A PNG's signature and IHDR chunk: all `pngSize` reads. */
function header(width: number, height: number, length = 64) {
  const bytes = new Uint8Array(length)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('pngSize', () => {
  it('reads the size from the header', () => {
    expect(pngSize(header(480, 300))).toEqual({ width: 480, height: 300 })
  })

  it('is null for anything else', () => {
    expect(pngSize(new TextEncoder().encode('<!doctype html><html></html>'))).toBeNull()
    expect(pngSize(header(480, 300).subarray(0, 20))).toBeNull()
    const noIhdr = header(480, 300)
    noIhdr[12] = 0x58
    expect(pngSize(noIhdr)).toBeNull()
  })
})

describe('thumbnailProblem', () => {
  it('takes a PNG of a thumbnail’s size', () => {
    expect(thumbnailProblem(header(480, 300))).toBeNull()
  })

  it('refuses one too heavy, too small or too big, or not a PNG', () => {
    expect(thumbnailProblem(header(480, 300, THUMBNAIL_MAX_BYTES + 1))?.code).toBe('too_large')
    expect(thumbnailProblem(header(4, 300))?.code).toBe('bad_thumbnail')
    expect(thumbnailProblem(header(480, 5000))?.code).toBe('bad_thumbnail')
    expect(thumbnailProblem(new Uint8Array(100))?.code).toBe('bad_thumbnail')
  })
})

describe('wantsThumbnail', () => {
  const site = { role: 'owner', archived: false, currentVersionId: 'v2' }

  it('asks an owner or a publisher for one when there is none, or it is of another version', () => {
    expect(wantsThumbnail(site)).toBe(true)
    expect(wantsThumbnail({ ...site, role: 'publisher' })).toBe(true)
    expect(wantsThumbnail({ ...site, thumbnail: { versionId: 'v1' } })).toBe(true)
    expect(wantsThumbnail({ ...site, thumbnail: { versionId: 'v2' } })).toBe(false)
  })

  it('never asks an admin or anyone else, nor for a site that is offline', () => {
    expect(wantsThumbnail({ ...site, role: 'admin' })).toBe(false)
    expect(wantsThumbnail({ ...site, role: undefined })).toBe(false)
    expect(wantsThumbnail({ ...site, archived: true })).toBe(false)
    expect(wantsThumbnail({ ...site, currentVersionId: null })).toBe(false)
  })
})

describe('addresses', () => {
  it('reads a thumbnail at an address of its own', () => {
    expect(thumbnailUrl('deck', '2026-01-01T00:00:00.000Z')).toBe(
      '/api/sites/deck/thumbnail?v=2026-01-01T00%3A00%3A00.000Z'
    )
  })

  it('opens the shell in preview mode on the home page', () => {
    const url = new URL(previewShellUrl('https://deck.sites.example.test/'))
    expect(url.pathname).toBe('/_fling/review.html')
    expect(url.searchParams.get('path')).toBe('/')
    expect(isPreviewMode(url.search)).toBe(true)
    expect(isPreviewMode('?path=%2F')).toBe(false)
  })
})
