import { join } from 'node:path'
import { type InstanceMetadata, SERVER_BUNDLE, SERVER_TEMPLATE } from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/api.ts'
import type { ConfigStore } from '../src/config.ts'
import { createMcpServer } from '../src/mcp.ts'
import {
  INSTANCE,
  jsonResponse,
  mockFetch,
  runCleanups,
  SERVER,
  site,
  TEST_KEY,
  tempDir,
  tempStore,
  writeTree,
} from './helpers.ts'

afterEach(runCleanups)

const VERSION = '0123456789abcdef'
const SERVERS_ON: InstanceMetadata = {
  ...INSTANCE,
  capabilities: { ...INSTANCE.capabilities, servers: true, serversEgress: false },
}

async function connect(instance: InstanceMetadata, fetchImpl?: FetchLike) {
  const { store } = await tempStore()
  await store.putServer(SERVER, { instance, apiKey: TEST_KEY })
  return connectTo(store, instance, fetchImpl)
}

async function connectTo(store: ConfigStore, instance: InstanceMetadata, fetchImpl?: FetchLike) {
  const home = await tempDir()
  const server = createMcpServer({
    store,
    fetch: fetchImpl,
    cwd: home,
    waitReady: async () => ({ ready: true, waitedMs: 0 }),
    servers: [{ url: SERVER, instance, current: true, signedIn: true }],
    locate: { cwd: home, home, platform: process.platform, env: {} },
  })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''

describe('site server tools on the local MCP', () => {
  it('are offered only where a Fling runs servers', async () => {
    const names = async (instance: InstanceMetadata) =>
      (await (await connect(instance)).listTools()).tools.map(t => t.name)
    const on = await names(SERVERS_ON)
    for (const tool of ['fling_logs', 'fling_server_template', 'fling_dev']) {
      expect(on).toContain(tool)
    }
    const off = await names(INSTANCE)
    expect(off.filter(n => n === 'fling_logs' || n === 'fling_dev')).toEqual([])
  })

  it('fling_server_template gives the dependency-free server, and no tool takes a secret value', async () => {
    const client = await connect(SERVERS_ON)
    const r = await client.callTool({ name: 'fling_server_template', arguments: {} })
    expect(text(r)).toContain(SERVER_TEMPLATE)
    const tools = (await client.listTools()).tools
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {})
      expect(props.filter(p => /value|secretValue/i.test(p))).toEqual([])
    }
  })

  it('fling_deploy bundles the server, and a start that failed comes back with its log', async () => {
    const root = await tempDir()
    const dir = join(root, 'my-app')
    await writeTree(dir, {
      'index.html': 'x',
      'server.js': 'export default { fetch: () => new Response("ok") }',
      'fling.json': '{"secrets":["K"]}',
    })
    const bodies: any[] = []
    let finalize = () =>
      jsonResponse(
        {
          error: {
            code: 'server_failed_to_start',
            message: "Not published: it didn't start. Its log:\nReferenceError: y",
            logs: ['ReferenceError: y'],
          },
        },
        422
      )
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': (_u, init) => {
        bodies.push(JSON.parse(String(init.body)))
        return jsonResponse({
          status: 'upload',
          versionId: VERSION,
          uploads: [{ path: SERVER_BUNDLE, url: 'https://s3.test/put/b', headers: {} }],
        })
      },
      'PUT /put/b': () => new Response(null, { status: 200 }),
      [`POST /api/sites/my-app/deploys/${VERSION}/finalize`]: () => finalize(),
    })
    const client = await connect(SERVERS_ON, m.fetch)
    const failed = await client.callTool({
      name: 'fling_deploy',
      arguments: { path: dir, name: 'my-app' },
    })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toMatch(
      /server_failed_to_start[\s\S]*ReferenceError: y[\s\S]*fling_deploy again/
    )
    expect(bodies[0].server).toEqual({ secrets: ['K'] })

    finalize = () =>
      jsonResponse({ status: 'live', versionId: VERSION, site: site({ hasServer: true }) })
    const ok = await client.callTool({
      name: 'fling_deploy',
      arguments: { path: dir, name: 'my-app' },
    })
    expect(text(ok)).toMatch(/Its server answers \/api\/\* \(outbound network: none; secrets: K\)/)
    expect(text(ok)).toContain('fling_logs')
  })

  it('fling_logs reads the log', async () => {
    const m = mockFetch({
      'GET /api/sites/my-app/logs': () =>
        jsonResponse({
          lines: [
            {
              at: '2026-11-15T06:12:03.000Z',
              versionId: VERSION,
              kind: 'request',
              method: 'GET',
              path: '/api/me',
              status: 200,
              ms: 4,
              viewer: 'v_abc',
            },
          ],
        }),
    })
    const client = await connect(SERVERS_ON, m.fetch)
    const r = await client.callTool({ name: 'fling_logs', arguments: { name: 'my-app' } })
    expect(text(r)).toContain('06:12:03  GET /api/me  200  4 ms  v_abc  version 0123456789abcdef')
  })
})
