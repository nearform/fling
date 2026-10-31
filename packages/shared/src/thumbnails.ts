// Thumbnails (the `thumbnails` capability): a small PNG of a site's home page, taken in the browser
// of an owner or publisher who opens the site page, by the preview shell (the review shell in
// preview mode, review-bridge.ts), and uploaded with `PUT /api/sites/<name>/thumbnail?version=<id>`
// for the version it was taken of. The server keeps it while that version is current; a site whose
// thumbnail is of another version (or has none) gets a new one the next time an owner or publisher
// opens its page. Browser-safe (zod only).

import { z } from 'zod'

/** The desktop viewport the preview frames the home page at (CSS px), then scales down. */
export const PREVIEW_VIEWPORT = { width: 1280, height: 800 } as const

/** The size the shell draws a thumbnail at: the preview viewport, scaled down. */
export const THUMBNAIL_SIZE = { width: 480, height: 300 } as const

/** The most a thumbnail may weigh (413 `too_large` beyond it). */
export const THUMBNAIL_MAX_BYTES = 200 * 1024

/** The sides a thumbnail may have, in pixels (400 `bad_thumbnail` outside them). */
export const THUMBNAIL_MIN_SIDE = 16
export const THUMBNAIL_MAX_SIDE = 960

/** The thumbnail as the owners' and publishers' view of a site reports it: what it was taken of, and when. */
export const ThumbnailSchema = z.object({ versionId: z.string(), updatedAt: z.string() })
export type Thumbnail = z.infer<typeof ThumbnailSchema>

/** The thumbnail as a listing reports it (Shared with me, All sites): when it was taken. */
export const ThumbnailStampSchema = z.object({ updatedAt: z.string() })
export type ThumbnailStamp = z.infer<typeof ThumbnailStampSchema>

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * A PNG's width and height from its header: the signature, then the IHDR chunk first, as the
 * format requires. null for anything that isn't a PNG.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  if (PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Chunk length 13, type "IHDR".
  if (view.getUint32(8) !== 13) return null
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Why a thumbnail's bytes are refused, or null when they will do. */
export function thumbnailProblem(
  bytes: Uint8Array
): { code: 'too_large' | 'bad_thumbnail'; message: string } | null {
  if (bytes.length > THUMBNAIL_MAX_BYTES) {
    return {
      code: 'too_large',
      message: `A thumbnail may be at most ${THUMBNAIL_MAX_BYTES / 1024} KB`,
    }
  }
  const size = pngSize(bytes)
  if (!size) return { code: 'bad_thumbnail', message: 'A thumbnail must be a PNG' }
  const ok = (n: number) => n >= THUMBNAIL_MIN_SIDE && n <= THUMBNAIL_MAX_SIDE
  if (!ok(size.width) || !ok(size.height)) {
    return {
      code: 'bad_thumbnail',
      message: `A thumbnail's sides must be ${THUMBNAIL_MIN_SIDE} to ${THUMBNAIL_MAX_SIDE} pixels`,
    }
  }
  return null
}

/**
 * Where the app reads a site's thumbnail. `updatedAt` (when it was taken) makes each one its own
 * address, so the browser keeps it until a new one replaces it.
 */
export function thumbnailUrl(name: string, updatedAt: string): string {
  return `/api/sites/${encodeURIComponent(name)}/thumbnail?v=${encodeURIComponent(updatedAt)}`
}

/**
 * Whether the browser of whoever is looking at the site page should take a new thumbnail: they own
 * or publish the site, it is live, and it has none or one of another version.
 */
export function wantsThumbnail(site: {
  role?: string | undefined
  archived: boolean
  currentVersionId: string | null
  thumbnail?: Pick<Thumbnail, 'versionId'> | undefined
}): boolean {
  if (site.role !== 'owner' && site.role !== 'publisher') return false
  if (site.archived || site.currentVersionId === null) return false
  return site.thumbnail?.versionId !== site.currentVersionId
}
