/**
 * `/notifications/unsubscribe?t=<token>` on the app origin, without a session (design §4.2):
 *
 * - `GET` shows a small page naming the event the token is about, with a button to stop those
 *   emails and one to stop all email from the instance. It changes nothing, so mail scanners that
 *   follow links unsubscribe nobody.
 * - `POST` changes the preferences: the mail client's RFC 8058 one-click POST (body
 *   `List-Unsubscribe=One-Click`) and the page's first button turn the event's cell off;
 *   `scope=all` mutes everything; `undo=1` reverts either. The answer offers Undo and the settings
 *   page.
 * - A token that does not verify gets the same neutral page, whatever it was.
 *
 * Server-rendered, so it works in any mail client's browser; inline styles only, and a CSP that
 * allows them and forms posting back here, nothing else.
 */
import { eventDefinition, NOTIFICATION_SETTINGS_PATH, UNSUBSCRIBE_PATH } from '@fling/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { instanceMetadata } from '../instance.ts'
import { escapeHtml as e } from '../notifications/templates/layout.ts'
import {
  applyUnsubscribe,
  type UnsubscribeTarget,
  verifyUnsubscribeToken,
} from '../notifications/unsubscribe.ts'
import type { AppEnv } from '../types.ts'

export const notificationRoutes = new Hono<AppEnv>()

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

function page(c: Context<AppEnv>, title: string, body: string, status: 200 | 400 = 200) {
  const { config } = c.get('deps')
  const meta = instanceMetadata(config)
  const colors = {
    primary: '#111827',
    primaryContent: '#ffffff',
    ink: '#111827',
    ...meta.brand.colors,
  }
  c.header('Content-Security-Policy', PAGE_CSP)
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} · ${e(meta.name)}</title>
<style>
body{margin:0;background:#f3f4f6;color:${e(colors.ink)};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
main{max-width:480px;margin:48px auto;padding:24px;background:#fff;border-radius:8px}
h1{font-size:20px;margin:0 0 12px}p{font-size:15px;line-height:22px;margin:0 0 12px}
form{margin:0 0 12px}button{font:inherit;font-size:15px;padding:10px 18px;border-radius:6px;cursor:pointer}
.primary{background:${e(colors.primary)};color:${e(colors.primaryContent)};border:0;font-weight:600}
.secondary{background:#fff;color:${e(colors.ink)};border:1px solid #d1d5db}
.name{font-weight:700;margin-bottom:16px}a{color:${e(colors.ink)}}small{color:#6b7280}
</style></head>
<body><main><p class="name">${e(meta.name)}</p><h1>${e(title)}</h1>${body}</main></body></html>`
  return c.html(html, status)
}

const action = (token: string) => `${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`

const form = (
  token: string,
  label: string,
  fields: Record<string, string>,
  kind: 'primary' | 'secondary'
) =>
  `<form method="post" action="${e(action(token))}">${Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`)
    .join('')}<button class="${kind}" type="submit">${e(label)}</button></form>`

function settingsLink(c: Context<AppEnv>) {
  const { appOrigin } = c.get('deps').config
  return `<p><small><a href="${e(appOrigin + NOTIFICATION_SETTINGS_PATH)}">Choose what you hear about</a> (you sign in first).</small></p>`
}

function invalid(c: Context<AppEnv>) {
  return page(
    c,
    'This link does not work',
    `<p>It may have been copied incompletely. You can choose what you hear about in your settings.</p>${settingsLink(c)}`,
    400
  )
}

const what = (target: UnsubscribeTarget) => eventDefinition(target.event).title.toLowerCase()

notificationRoutes.get('/unsubscribe', c => {
  const { config } = c.get('deps')
  const token = c.req.query('t') ?? ''
  const target = verifyUnsubscribeToken(config.secrets.sessionSecret, token)
  if (!target) return invalid(c)
  return page(
    c,
    'Stop these emails?',
    `<p>You get an email at ${e(target.email)} when ${e(what(target))}.</p>${form(
      token,
      'Stop these emails',
      { scope: 'event' },
      'primary'
    )}${form(token, `Stop all email from ${instanceMetadata(config).name}`, { scope: 'all' }, 'secondary')}${settingsLink(c)}`
  )
})

notificationRoutes.post('/unsubscribe', async c => {
  const deps = c.get('deps')
  let fields: Record<string, string> = {}
  try {
    const body = await c.req.parseBody()
    fields = Object.fromEntries(
      Object.entries(body).filter((e): e is [string, string] => typeof e[1] === 'string')
    )
  } catch {
    // An empty or unreadable body is the plain one-click unsubscribe.
  }
  const token = c.req.query('t') ?? fields.t ?? ''
  const target = verifyUnsubscribeToken(deps.config.secrets.sessionSecret, token)
  if (!target) return invalid(c)
  const scope = fields.scope === 'all' ? 'all' : 'event'
  const undo = fields.undo === '1'
  await applyUnsubscribe(deps, target, { scope, undo })
  const name = instanceMetadata(deps.config).name
  if (undo) {
    return page(
      c,
      'Emails are back on',
      `<p>${e(target.email)} gets ${scope === 'all' ? `email from ${e(name)}` : `an email when ${e(what(target))}`} again.</p>${settingsLink(c)}`
    )
  }
  return page(
    c,
    'Unsubscribed',
    `<p>${e(target.email)} gets no more ${scope === 'all' ? `email from ${e(name)}` : `emails when ${e(what(target))}`}.</p>${form(
      token,
      'Undo',
      { scope, undo: '1' },
      'secondary'
    )}${settingsLink(c)}`
  )
})
