/**
 * Local affordances for notifications, mounted only with the dev login on (never in production):
 *
 * - `POST /dev/notify/drain`: drain the outbox now, including what is due in the next hour
 *   (`flush`), so local runs and the e2e scenario need not wait for a tick or a fold. Answers the
 *   drain's result.
 * - `GET /dev/mail`: the messages the mailer kept (FileMailer's `.fling-dev/mail/`, or
 *   MemoryMailer's), newest first: JSON when asked for it, else a page linking each one.
 * - `GET /dev/mail/:id`: one message's HTML part.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { FileMailer } from '../mail/file.ts'
import { MemoryMailer } from '../mail/memory.ts'
import { drain } from '../notifications/drain.ts'
import { escapeHtml as e } from '../notifications/templates/layout.ts'
import type { AppEnv } from '../types.ts'

export const devRoutes = new Hono<AppEnv>()

devRoutes.post('/notify/drain', async c => {
  return c.json(await drain(c.get('deps'), { flush: true }))
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
  if (mailer instanceof MemoryMailer) {
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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local mail</title><style>body{font-family:sans-serif;margin:24px}td{padding:4px 12px 4px 0}</style></head><body><h1>Local mail</h1>${
      messages.length ? `<table>${rows}</table>` : '<p>Nothing sent yet.</p>'
    }</body></html>`
  )
})

devRoutes.get('/mail/:id', async c => {
  const { mailer } = c.get('deps')
  const id = c.req.param('id')
  let html: string | null = null
  if (mailer instanceof FileMailer) html = await mailer.read(id, 'html')
  else if (mailer instanceof MemoryMailer) {
    html = mailer.sent.find(m => m.providerId === id)?.message.html ?? null
  }
  if (html === null)
    return c.json({ error: { code: 'not_found', message: 'No such message' } }, 404)
  c.header('Content-Security-Policy', PAGE_CSP)
  return c.html(html)
})
