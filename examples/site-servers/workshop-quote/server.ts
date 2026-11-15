// The site's server. Fling runs it for /api/* and nothing else; every other path is the
// static files. Bundled by `fling deploy` into _fling/server.mjs with hono and zod inside it.
import { Hono } from 'hono'
import { z } from 'zod'

/** Who Fling says is calling: from the visitor's sign-in, never from the browser. */
type Viewer = { id: string; email: string; guest: boolean } | null
const viewerOf = (header: string | undefined): Viewer => (header ? JSON.parse(header) : null)

const app = new Hono().basePath('/api')

// GET /api/health: what Fling's start probe calls (fling.json "health") before this version
// goes live. It checks the server's own needs, not Fling's: here, that the webhook URL is
// usable. It never posts to Slack.
app.get('/health', c => {
  const url = process.env.SLACK_WEBHOOK_URL ?? ''
  if (!url.startsWith('https://hooks.slack.com/')) {
    return c.json({ ok: false, problem: 'SLACK_WEBHOOK_URL' }, 503)
  }
  return c.json({ ok: true })
})

// GET /api/me: who is looking (null on a public site or through a share link).
app.get('/me', c => c.json(viewerOf(c.req.header('x-fling-viewer')) ?? { email: null }))

const Quote = z.object({
  people: z.number().int().min(1).max(200),
  days: z.number().int().min(1).max(10),
  format: z.enum(['remote', 'onsite']),
})
type Quote = z.infer<typeof Quote>
const INVALID = 'People 1–200, days 1–10, remote or on site.'

// Rates live in the server, not the page: visitors see a price, never the price list.
const DAY_RATE = 4_000
const PER_PERSON_PER_DAY = 85
const ONSITE_UPLIFT = 0.15

function price({ people, days, format }: Quote) {
  const base = DAY_RATE * days
  const seats = PER_PERSON_PER_DAY * people * days
  const uplift = format === 'onsite' ? Math.round((base + seats) * ONSITE_UPLIFT) : 0
  const breakdown = [`£${base} facilitation`, `£${seats} materials`]
  if (uplift) breakdown.push(`£${uplift} on site`)
  return { total: base + seats + uplift, breakdown }
}

// POST /api/quote: a validated price with its working.
app.post('/quote', async c => {
  const input = Quote.safeParse(await c.req.json().catch(() => null))
  if (!input.success) return c.json({ error: INVALID }, 400)
  return c.json(price(input.data))
})

// POST /api/request: sends the quote to the team's Slack channel. Uses the network and the
// SLACK_WEBHOOK_URL site secret (declared in fling.json, set with `fling secrets set`).
app.post('/request', async c => {
  const viewer = viewerOf(c.req.header('x-fling-viewer'))
  if (!viewer) return c.json({ error: 'Sign in to request a workshop.' }, 401)
  const input = Quote.safeParse(await c.req.json().catch(() => null))
  if (!input.success) return c.json({ error: INVALID }, 400)
  const { people, days, format } = input.data
  const { total } = price(input.data)

  const res = await fetch(process.env.SLACK_WEBHOOK_URL as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `${viewer.email} asked for a ${days}-day ${format} workshop for ${people}: £${total}`,
    }),
  })
  if (!res.ok) {
    console.error('Slack answered', res.status)
    return c.json({ error: 'Could not send the request. Try again in a minute.' }, 502)
  }
  // The viewer id, not the email: logs are read by everyone who publishes the site.
  console.log('workshop requested', viewer.id, total)
  return c.json({ sent: true, total })
})

app.notFound(c => c.json({ error: 'No such endpoint' }, 404))

export default app
