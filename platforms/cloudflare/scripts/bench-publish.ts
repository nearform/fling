/**
 * Micro-benchmark: Worker CPU for a ~4 MB remote MCP publish (the MCP_PUBLISH_MAX_BYTES cap), run
 * in workerd via Miniflare. `pnpm --filter @fling/platform-cloudflare bench:publish`.
 *
 * Workers bill CPU, not wall time, and the work here is pure compute, so each request's wall time
 * in workerd less a baseline request carrying the same body (parsing the HTTP body costs the
 * same in both) is its CPU time. Runs a warm-up, then reports the median of N.
 *
 * Measured 2026-10 on an Apple Silicon laptop (workerd 1.20260730): 9-13 ms for 4 MB of text
 * (densely packed near-miss secrets being the slowest), ~6 ms when half of it is binary. Cloudflare's
 * cores are slower than a laptop's, so allow a few times that: tens of ms, against the Paid plan's
 * 30 s default (the Free plan's 10 ms is not enough).
 */
import { join } from 'node:path'
import { MCP_PUBLISH_MAX_BYTES } from '@fling/shared/mcp-tools'
import { Miniflare } from 'miniflare'
import { bundle, COMPATIBILITY } from '../tests/miniflare.ts'

const RUNS = Number(process.env.RUNS ?? 15)

/** Deterministic text that looks like a built site: markup, CSS, minified JS with long lines. */
function textFile(i: number, size: number) {
  const chunks = [
    `<div class="card c${i}"><a href="/p/${i}">Item ${i}</a><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p></div>\n`,
    `.c${i}{margin:0 auto;padding:${i % 9}px;color:#${(i * 2654435761).toString(16).slice(-6)}}\n`,
    `function f${i}(a,b){return a.map(x=>x*${i}+b).filter(Boolean).join(",")};var k${i}="v${i}-${'x'.repeat(40)}";`,
  ]
  let out = ''
  for (let n = 0; out.length < size; n++) out += chunks[n % chunks.length]
  return out.slice(0, size)
}

/** Near misses for every rule (prefixes without the rest), packed densely: the scan's worst case. */
function nearMisses(size: number) {
  const chunk =
    'AKIA12 sk-proj-short ghp_abc npm_x xoxb-1-a SG.a.b GOCSPX-a AccountKey=abc ' +
    'postgres://user:pa@ mysql://u:p@db -----BEGIN PRIVATE KEY----- secret_access_key=abc '
  return chunk.repeat(Math.ceil(size / chunk.length)).slice(0, size)
}

/** `count` files totalling ~`total` bytes; `binaryShare` of them base64 PNG-ish bytes (not scanned). */
function payload(total: number, count: number, binaryShare: number) {
  const files = []
  const each = Math.floor(total / count)
  for (let i = 0; i < count; i++) {
    if (i < count * binaryShare) {
      const bytes = new Uint8Array(each)
      for (let j = 0; j < each; j++) bytes[j] = (i * 31 + j * 17) & 0xff
      bytes[0] = 0x89
      files.push({
        path: `img/${i}.png`,
        content: Buffer.from(bytes).toString('base64'),
        encoding: 'base64',
      })
    } else {
      const ext = ['html', 'css', 'js'][i % 3]
      files.push({ path: `${ext}/${i}.${ext}`, content: textFile(i, each), encoding: 'utf8' })
    }
  }
  return JSON.stringify({ files })
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number

const mf = new Miniflare({
  modules: true,
  script: await bundle(join(import.meta.dirname, 'bench-worker.ts')),
  ...COMPATIBILITY,
})
try {
  const cases = [
    { name: '4 MB text, 1 file', body: payload(MCP_PUBLISH_MAX_BYTES, 1, 0) },
    { name: '4 MB text, 200 files', body: payload(MCP_PUBLISH_MAX_BYTES, 200, 0) },
    {
      name: '4 MB of near-miss secrets, 20 files',
      body: JSON.stringify({
        files: Array.from({ length: 20 }, (_, i) => ({
          path: `env/${i}.txt`,
          content: nearMisses(MCP_PUBLISH_MAX_BYTES / 20),
          encoding: 'utf8',
        })),
      }),
    },
    {
      name: '4 MB, 50% binary (base64), 200 files',
      body: payload(MCP_PUBLISH_MAX_BYTES, 200, 0.5),
    },
  ]
  const time = async (path: string, body: string) => {
    const start = performance.now()
    const res = await mf.dispatchFetch(`http://bench${path}`, { method: 'POST', body })
    const out = await res.json()
    return { ms: performance.now() - start, out }
  }
  console.log(`median of ${RUNS} runs, after 3 warm-up runs`)
  for (const c of cases) {
    for (let i = 0; i < 3; i++) await time('/publish', c.body)
    const base: number[] = []
    const work: number[] = []
    let out: unknown
    for (let i = 0; i < RUNS; i++) {
      base.push((await time('/baseline', c.body)).ms)
      const r = await time('/publish', c.body)
      work.push(r.ms)
      out = r.out
    }
    const cpu = median(work) - median(base)
    console.log(
      `${c.name.padEnd(40)} body ${(c.body.length / 1e6).toFixed(1)} MB  ` +
        `publish ${median(work).toFixed(1)} ms - baseline ${median(base).toFixed(1)} ms ` +
        `= ~${cpu.toFixed(1)} ms CPU  ${JSON.stringify(out)}`
    )
  }
} finally {
  await mf.dispose()
}
