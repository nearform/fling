/**
 * The email layout: one message from its sections, as plain text and as simple HTML (a table
 * layout with inline styles; no external CSS, images, tracking pixel or click tracking). Every
 * inserted value is escaped here. Branded from the instance metadata: the name in the subject and
 * as a text header, `primary` and `primaryContent` for the button, `ink` for text. No logo, since
 * most mail clients render neither `data:` URLs nor SVG.
 *
 * The footer says why the recipient got it, offers the one-click unsubscribe for each event in
 * the message and the settings page, says which account opens the links, and for comment emails
 * that replies to the email are not posted.
 */
import type { InstanceBrand } from '@fling/shared'
import type { Section } from './types.ts'

export interface Footer {
  /** the recipient's address and how they sign in ("Google") */
  to: string
  signIn: string
  /** one per event in the message: what it is, and its unsubscribe link */
  unsubscribe: { title: string; url: string }[]
  settingsUrl: string
  /** comment emails: replies to this email go nowhere */
  commentNote: boolean
}

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

const DEFAULTS = { primary: '#111827', primaryContent: '#ffffff', ink: '#111827' }

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const COMMENT_NOTE = 'Reply on the review page; replies to this email are not posted.'

function footerLines(footer: Footer, sections: Section[]): string[] {
  return [
    `Open the links signed in as ${footer.to} (${footer.signIn}).`,
    ...(footer.commentNote ? [COMMENT_NOTE] : []),
    ...sections.map(s => `You got this email because ${s.why}.`),
  ]
}

export function renderEmail(
  instance: { name: string; brand: InstanceBrand },
  sections: Section[],
  subject: string,
  footer: Footer
): RenderedEmail {
  const fullSubject = `${instance.name}: ${subject}`
  return {
    subject: fullSubject,
    text: renderText(instance.name, sections, footer),
    html: renderHtml(instance, fullSubject, sections, footer),
  }
}

function renderText(name: string, sections: Section[], footer: Footer): string {
  const out: string[] = [name, '']
  for (const s of sections) {
    out.push(s.lead)
    for (const q of s.quotes ?? []) out.push('', `  "${q.text}"${q.by ? ` (${q.by})` : ''}`)
    if (s.links?.length) out.push('', ...s.links.map(l => `- ${l.text}: ${l.url}`))
    if (s.lines?.length) out.push('', ...s.lines)
    out.push('', `${s.action.label}: ${s.action.url}`, '')
  }
  out.push('--', ...footerLines(footer, sections), '')
  for (const u of footer.unsubscribe) out.push(`Stop emails when "${u.title}": ${u.url}`)
  out.push(`Choose what you hear about: ${footer.settingsUrl}`, '')
  return out.join('\n')
}

function renderHtml(
  instance: { name: string; brand: InstanceBrand },
  subject: string,
  sections: Section[],
  footer: Footer
): string {
  const colors = { ...DEFAULTS, ...instance.brand.colors }
  const e = escapeHtml
  const p = (html: string, style = '') =>
    `<p style="margin:0 0 12px 0;font-size:15px;line-height:22px;${style}">${html}</p>`
  const small = (html: string) =>
    `<p style="margin:0 0 8px 0;font-size:12px;line-height:18px;color:#6b7280">${html}</p>`
  const link = (text: string, url: string) =>
    `<a href="${e(url)}" style="color:${e(colors.ink)};text-decoration:underline">${e(text)}</a>`

  const body = sections
    .map(s => {
      const parts = [p(e(s.lead))]
      for (const q of s.quotes ?? []) {
        parts.push(
          `<blockquote style="margin:0 0 12px 0;padding:8px 12px;border-left:3px solid ${e(colors.primary)};background:#f9fafb;font-size:14px;line-height:20px;white-space:pre-wrap">${e(q.text)}${q.by ? `<br><span style="color:#6b7280">${e(q.by)}</span>` : ''}</blockquote>`
        )
      }
      if (s.links?.length) {
        parts.push(
          `<ul style="margin:0 0 12px 0;padding-left:20px;font-size:15px;line-height:22px">${s.links.map(l => `<li>${link(l.text, l.url)}</li>`).join('')}</ul>`
        )
      }
      for (const line of s.lines ?? []) parts.push(p(e(line)))
      parts.push(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px 0"><tr><td style="border-radius:6px;background:${e(colors.primary)}"><a href="${e(s.action.url)}" style="display:inline-block;padding:10px 18px;font-size:15px;font-weight:600;color:${e(colors.primaryContent)};text-decoration:none">${e(s.action.label)}</a></td></tr></table>`
      )
      return parts.join('')
    })
    .join('')

  const foot = [
    ...footerLines(footer, sections).map(line => small(e(line))),
    ...footer.unsubscribe.map(u =>
      small(`${link('Stop these emails', u.url)} (${e(u.title.toLowerCase())})`)
    ),
    small(link('Choose what you hear about', footer.settingsUrl)),
  ].join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;color:${e(colors.ink)};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:8px">
<tr><td style="padding:20px 24px 4px 24px;font-size:18px;font-weight:700;color:${e(colors.ink)}">${e(instance.name)}</td></tr>
<tr><td style="padding:12px 24px 4px 24px;color:${e(colors.ink)}">${body}</td></tr>
<tr><td style="padding:12px 24px 20px 24px;border-top:1px solid #e5e7eb">${foot}</td></tr>
</table>
</td></tr></table>
</body></html>
`
}
