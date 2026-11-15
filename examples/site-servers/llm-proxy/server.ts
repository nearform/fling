// An LLM proxy: the page posts a question to /api/ask, and this server asks Claude with the
// site's ANTHROPIC_API_KEY, streaming the answer back as plain text. The key is a site secret,
// so it never reaches the page, the published files or the bundle.
//
// Needs an instance whose servers may reach the internet (SERVERS_EGRESS=open): with `none`,
// the call to the Messages API throws and /api/ask answers 502.
import { secret, viewer } from '@nearform/fling/server'

const MODEL = 'claude-haiku-5-5'
const MAX_QUESTION = 2_000
// Fling stops every request after 30 s, streams included. Stopping the upstream call a little
// earlier lets the answer end with a note instead of being cut off mid-word.
const UPSTREAM_TIMEOUT_MS = 25_000

const json = (body: unknown, status = 200) => Response.json(body, { status })

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' && pathname === '/api/health') return health()
    if (request.method === 'POST' && pathname === '/api/ask') return ask(request)
    return json({ error: 'No such endpoint' }, 404)
  },
}

// GET /api/health: the start probe's check. It looks at the key's shape and never calls the
// API, so a publish doesn't spend tokens.
function health() {
  try {
    if (!secret('ANTHROPIC_API_KEY').startsWith('sk-ant-')) throw new Error('malformed')
    return json({ ok: true })
  } catch {
    return json({ ok: false, problem: 'ANTHROPIC_API_KEY' }, 503)
  }
}

async function ask(request: Request) {
  // Only signed-in viewers spend the key. On a public site or through a share link the viewer
  // is null, so anyone who can open the page could otherwise call /api/ask directly.
  const who = viewer(request)
  if (!who) return json({ error: 'Sign in to ask.' }, 401)

  const body = await request.json().catch(() => null)
  const question = typeof body?.question === 'string' ? body.question.trim() : ''
  if (!question || question.length > MAX_QUESTION) {
    return json({ error: `Ask a question of 1 to ${MAX_QUESTION} characters.` }, 400)
  }

  let upstream: Response
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': secret('ANTHROPIC_API_KEY'),
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        stream: true,
        system: 'Answer briefly and plainly, in British English.',
        messages: [{ role: 'user', content: question }],
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    // With SERVERS_EGRESS=none this is where it fails: the server has no outbound network.
    console.error('Messages API unreachable', String(error))
    return json({ error: 'The server could not reach the model.' }, 502)
  }
  if (!upstream.ok || !upstream.body) {
    console.error('Messages API answered', upstream.status, await upstream.text())
    return json({ error: 'The model did not answer. Try again in a minute.' }, 502)
  }

  // The viewer id, not the email: logs are read by everyone who publishes the site.
  console.log('ask', who.id, question.length)
  return new Response(answerText(upstream.body), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The Messages API's server-sent events, reduced to the text of the answer. */
function answerText(events: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = events.pipeThrough(new TextDecoderStream()).getReader()
  const encoder = new TextEncoder()
  let pending = ''
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) return controller.close()
        const lines = (pending + value).split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const text = textOf(line)
          if (text) controller.enqueue(encoder.encode(text))
        }
      } catch (error) {
        console.error('answer stream stopped', String(error))
        controller.enqueue(encoder.encode('\n\n[Cut off: the answer took too long.]'))
        controller.close()
      }
    },
    cancel() {
      reader.cancel()
    },
  })
}

function textOf(line: string): string | undefined {
  if (!line.startsWith('data: ')) return undefined
  const event = JSON.parse(line.slice(6))
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return event.delta.text
  }
  if (event.type === 'error') return `\n\n[The model stopped: ${event.error?.message}]`
  return undefined
}
