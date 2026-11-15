// Fling's server helpers (`<cli>/server`) for a server run by Node: what entry.mjs resolves the
// bundle's import of them to. The contract is FlingServerHelpers (packages/shared site-server.ts);
// the CLI's own implementation, for `fling dev` and for bundles built against it, keeps the same
// behaviour. Plain JavaScript with no imports but node:*.
//
//   viewer(request)  who is calling: { id, email, guest } from x-fling-viewer, or null (a public
//                    site, a share link)
//   file(path)       a Response with one of the version's own files (FLING_FILES_DIR); 404 for a
//                    missing one, a dotfile or anything under _fling/
//   secret(name)     a site secret (process.env); throws, naming it, when it isn't set
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const VIEWER_HEADER = 'x-fling-viewer'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

function headerOf(request) {
  const headers = request?.headers
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(VIEWER_HEADER)
  const raw = headers[VIEWER_HEADER]
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null)
}

export function viewer(request) {
  const raw = headerOf(request)
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (typeof v?.id !== 'string' || typeof v?.email !== 'string') return null
    return { id: v.id, email: v.email, guest: v.guest === true }
  } catch {
    return null
  }
}

function filePath(path) {
  const p = String(path).replace(/^\/+/, '')
  if (!p || p.split('/').some(s => s === '' || s.startsWith('.'))) return null
  if (p.startsWith('_fling/')) return null
  return p
}

export async function file(path) {
  const p = filePath(path)
  const dir = process.env.FLING_FILES_DIR
  if (p && dir) {
    try {
      const body = await readFile(join(dir, p))
      const type = TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream'
      return new Response(body, { headers: { 'content-type': type } })
    } catch {}
  }
  return new Response('Not found', { status: 404 })
}

export function secret(name) {
  const value = process.env[name]
  if (value === undefined || !(process.env.FLING_SECRET_NAMES || '').split(',').includes(name)) {
    throw new Error(
      `The site secret ${name} isn't set: declare it in fling.json and set it (fling secrets set)`
    )
  }
  return value
}

export default { viewer, file, secret }
