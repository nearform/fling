/**
 * The CPU-heavy part of a remote MCP publish, as a Worker (see bench-publish.ts): parse the request,
 * decode each file, SHA-256 it, scan it for secrets and derive the version id. The I/O around it
 * (D1, R2 writes) waits rather than computes, so it is left out.
 */

import { createHash } from 'node:crypto'
import { scanBytesForSecrets } from '@fling/shared/secrets'
import { computeVersionId } from '@fling/shared/version-id'

type Payload = { files: { path: string; content: string; encoding: 'utf8' | 'base64' }[] }

export default {
  async fetch(request: Request) {
    const text = await request.text()
    if (new URL(request.url).pathname === '/baseline') return Response.json({ n: text.length })
    const t0 = performance.now()
    const { files } = JSON.parse(text) as Payload
    const decoded = files.map(f => ({
      path: f.path,
      bytes:
        f.encoding === 'base64'
          ? new Uint8Array(Buffer.from(f.content, 'base64'))
          : new TextEncoder().encode(f.content),
    }))
    const t1 = performance.now()
    const manifest = decoded.map(f => ({
      path: f.path,
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
    }))
    const t2 = performance.now()
    const findings = decoded.flatMap(f => scanBytesForSecrets(f.bytes, f.path))
    const t3 = performance.now()
    const versionId = computeVersionId(manifest)
    return Response.json({
      versionId,
      findings: findings.length,
      bytes: decoded.reduce((n, f) => n + f.bytes.length, 0),
      // Only meaningful where the clock advances during compute (not in production Workers).
      ms: { decode: t1 - t0, sha256: t2 - t1, scan: t3 - t2 },
    })
  },
}
