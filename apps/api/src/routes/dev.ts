/**
 * Local affordances, mounted only with the dev login on (never in production: config.ts turns
 * DEV_LOGIN off there):
 *
 * - `POST /dev/notify/drain`: drain the outbox now, including what is due in the next hour
 *   (`flush`), so local runs and the e2e scenario need not wait for a tick or a fold. Answers the
 *   drain's result, or, posted from the mail page's form, sends the browser back to it.
 * - `GET /dev/mail`: the messages the mailer kept (FileMailer's `.fling-dev/mail/`,
 *   MemoryMailer's, or KeptMailer's copies of a platform mailer's), newest first: JSON when asked
 *   for it, else a page linking each one, with a button that drains the outbox now.
 * - `GET /dev/mail/:id`: one message's HTML part.
 * - `GET /dev/clock`, `POST /dev/clock { days }`: the dev clock (lib/dev-clock.ts) and moving it
 *   on by `days` (0 to 3650, fractions allowed), for the API's every use of `deps.clock`. 409
 *   `clock_fixed` where the instance runs another clock. The outbox goes with it: first drained
 *   as of the old time until complete, so nothing queued before is lost, then its walk is moved
 *   on to just behind the new time (drain.ts's `skipToNow`), so what is sent next goes with the
 *   next drain rather than once the walk has caught up the days between.
 * - `POST /dev/maintain`: run maintenance now (maintenance.ts, the archive policy included), as
 *   the platforms' schedulers run it; answers its result.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { DevClock } from '../lib/dev-clock.ts'
import { jsonBody } from '../lib/validate.ts'
import { FileMailer } from '../mail/file.ts'
import { KeptMailer } from '../mail/kept.ts'
import { MemoryMailer } from '../mail/memory.ts'
import { MAINTAIN_BUDGET_MS, maintain } from '../maintenance.ts'
import { drain, skipToNow } from '../notifications/drain.ts'
import { escapeHtml as e } from '../notifications/templates/layout.ts'
import type { AppEnv, Deps } from '../types.ts'

export const devRoutes = new Hono<AppEnv>()

devRoutes.post('/notify/drain', async c => {
  const result = await drain(c.get('deps'), { flush: true })
  if ((c.req.header('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) {
    return c.redirect('/dev/mail', 303)
  }
  return c.json(result)
})

interface Listed {
  id: string
  to: string
  subject: string
  date: string
}

async function listMail(c: Context<AppEnv>): Promise<Listed[]> {
  const { mailer } = c.get('deps')
  if (mailer instanceof FileMailer) {
    return (await mailer.list()).map(m => ({
      id: m.id,
      to: m.to,
      subject: m.subject,
      date: m.date,
    }))
  }
  if (mailer instanceof MemoryMailer || mailer instanceof KeptMailer) {
    return [...mailer.sent].reverse().map(m => ({
      id: m.providerId,
      to: m.message.to,
      subject: m.message.subject,
      date: m.sentAt.toISOString(),
    }))
  }
  return []
}

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'"

devRoutes.get('/mail', async c => {
  const messages = await listMail(c)
  if ((c.req.header('accept') ?? '').includes('application/json')) return c.json({ messages })
  c.header('Content-Security-Policy', PAGE_CSP)
  const rows = messages
    .map(
      m =>
        `<tr><td>${e(m.date)}</td><td>${e(m.to)}</td><td><a href="/dev/mail/${e(encodeURIComponent(m.id))}">${e(m.subject)}</a></td></tr>`
    )
    .join('')
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local mail</title><style>body{font-family:sans-serif;margin:24px}td{padding:4px 12px 4px 0}form{margin:0 0 16px}</style></head><body><h1>Local mail</h1><form method="post" action="/dev/notify/drain"><button type="submit">Send what is waiting</button> <small>Emails wait a couple of minutes in the outbox; this sends them now.</small></form>${
      messages.length ? `<table>${rows}</table>` : '<p>Nothing sent yet.</p>'
    }</body></html>`
  )
})

devRoutes.get('/mail/:id', async c => {
  const { mailer } = c.get('deps')
  const id = c.req.param('id')
  let html: string | null = null
  if (mailer instanceof FileMailer) html = await mailer.read(id, 'html')
  else if (mailer instanceof MemoryMailer || mailer instanceof KeptMailer) {
    html = mailer.sent.find(m => m.providerId === id)?.message.html ?? null
  }
  if (html === null)
    return c.json({ error: { code: 'not_found', message: 'No such message' } }, 404)
  c.header('Content-Security-Policy', PAGE_CSP)
  return c.html(html)
})

const ClockRequestSchema = z.object({ days: z.number().min(0).max(3650) })

const clockOf = (c: Context<AppEnv>) => {
  const { clock } = c.get('deps')
  return {
    now: clock.now().toISOString(),
    offsetMs: clock instanceof DevClock ? clock.offsetMs : 0,
  }
}

devRoutes.get('/clock', c => c.json(clockOf(c)))

devRoutes.post('/clock', async c => {
  const { days } = await jsonBody(c, ClockRequestSchema)
  const { clock, config } = c.get('deps')
  if (!(clock instanceof DevClock) || config.appEnv === 'production') {
    return c.json(
      { error: { code: 'clock_fixed', message: 'This instance runs the system clock' } },
      409
    )
  }
  const deps = c.get('deps')
  const caughtUp = await drainUntilComplete(deps)
  const from = clock.now()
  clock.advance(days * 86_400_000)
  if (!caughtUp || !(await skipToNow(deps, from))) {
    console.warn('dev clock: the outbox was busy, so its walk catches up the days moved on')
  }
  return c.json(clockOf(c))
})

/** How long `POST /dev/clock` drains, at most, for the outbox to catch up before it moves. */
const CATCH_UP_MS = 120_000

/** Drain (with `flush`) until a drain is complete; false if none was within CATCH_UP_MS. */
async function drainUntilComplete(deps: Deps) {
  const deadline = Date.now() + CATCH_UP_MS
  for (;;) {
    if ((await drain(deps, { flush: true })).complete) return true
    if (Date.now() > deadline) return false
    // Far behind, or a batch held by another drain: again, after a moment.
    await new Promise(r => setTimeout(r, 100))
  }
}

devRoutes.post('/maintain', async c =>
  c.json(await maintain(c.get('deps'), { deadline: Date.now() + MAINTAIN_BUDGET_MS }))
)
