/**
 * The site server suites against the local runtime: NodeSiteServers (a child process per version)
 * over fs blobs, with its output in MemoryServerLogs; and MemoryServerLogs on its own.
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FsBlobs } from '@fling/api/blobs/fs'
import { serverVersion } from '@fling/api/servers'
import { MemoryServerLogs } from '@fling/api/servers/memory-logs'
import { NodeSiteServers } from '@fling/api/servers/node'
import { serverLogsConformance, siteServersConformance } from '../src/index.ts'

siteServersConformance('NodeSiteServers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fling-servers-'))
  const blobs = new FsBlobs(join(root, 'blobs'), 'http://localhost:0', 'x'.repeat(32))
  const logs = new MemoryServerLogs()
  const servers = new NodeSiteServers({
    blobs,
    workDir: join(root, 'run'),
    filesDir: version => resolve(blobs.root, version.files),
    logs,
  })
  return {
    servers,
    logs,
    async putVersion(site, versionId, files) {
      const version = serverVersion(site.id, versionId)
      for (const [path, body] of Object.entries(files)) {
        const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
        await blobs.put(`${version.files}${path}`, bytes)
      }
      return version
    },
    async close() {
      await servers.close()
      await rm(root, { recursive: true, force: true })
    },
  }
})

serverLogsConformance('MemoryServerLogs', async () => {
  const logs = new MemoryServerLogs()
  return { logs, write: (siteId, lines) => logs.append(siteId, lines) }
})
