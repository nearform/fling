/**
 * FileMailer: local dev's mail. Each accepted message is written to a directory (`.fling-dev/mail/`
 * under `pnpm dev`) as `<id>.eml`, the whole MIME message any mail client opens, and `<id>.html`,
 * its HTML part to open in a browser. Ids sort by time, so the directory lists oldest first.
 * `list` reads them back (newest first) for the dev mail page and the conformance suite.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newSortableId } from '../lib/ids.ts'
import {
  BATCH_ID_HEADER,
  type Mailer,
  type MailMessage,
  type MailResult,
  prepareMessage,
  wasRefused,
} from './types.ts'

/** A message as written, read back from its `.eml`. */
export interface StoredMail {
  id: string
  to: string
  from: { address: string; name: string }
  subject: string
  date: string
  /** every header, by name as written */
  headers: Record<string, string>
}

const ASCII_TEXT = /^[\x20-\x7e]*$/

/** A header value: as is when printable ASCII, else an RFC 2047 encoded word. */
function encodeWord(value: string) {
  if (ASCII_TEXT.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function decodeWords(value: string) {
  return value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/gi, (_, b64: string) =>
    Buffer.from(b64, 'base64').toString('utf8')
  )
}

function formatAddress(from: { address: string; name: string }) {
  if (!from.name) return from.address
  const name = ASCII_TEXT.test(from.name)
    ? `"${from.name.replace(/["\\]/g, '\\$&')}"`
    : encodeWord(from.name)
  return `${name} <${from.address}>`
}

function parseAddress(value: string) {
  const match = /^(.*?)\s*<([^>]+)>$/.exec(value)
  if (!match) return { address: value, name: '' }
  const raw = (match[1] as string).trim()
  const name = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw
  return { address: match[2] as string, name: decodeWords(name) }
}

const base64Lines = (text: string) =>
  (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n')

/** The message as RFC 5322 text: headers, then a multipart/alternative body (text, then HTML). */
export function toEml(message: MailMessage, opts: { id: string; date: Date }): string {
  const boundary = `fling-${opts.id}`
  const headers: [string, string][] = [
    ['From', formatAddress(message.from)],
    ['To', message.to],
    ...(message.replyTo ? [['Reply-To', message.replyTo] as [string, string]] : []),
    ['Subject', encodeWord(message.subject)],
    ['Date', opts.date.toUTCString()],
    ['Message-ID', `<${opts.id}@fling.invalid>`],
    ['MIME-Version', '1.0'],
    [BATCH_ID_HEADER, message.batchId],
    ...(message.tags.length ? [['X-Fling-Tags', message.tags.join(', ')] as [string, string]] : []),
    ...Object.entries(message.headers).map(([k, v]): [string, string] => [k, encodeWord(v)]),
    ['Content-Type', `multipart/alternative; boundary="${boundary}"`],
  ]
  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=utf-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(body),
    ].join('\r\n')
  return [
    ...headers.map(([k, v]) => `${k}: ${v}`),
    '',
    part('text/plain', message.text),
    part('text/html', message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/** The headers of an `.eml` written by `toEml`. */
export function parseEmlHeaders(eml: string): Record<string, string> {
  const head = eml.split('\r\n\r\n', 1)[0] ?? ''
  const headers: Record<string, string> = {}
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon)] = line.slice(colon + 1).trim()
  }
  return headers
}

export class FileMailer implements Mailer {
  constructor(
    /** the directory the messages go in, e.g. `.fling-dev/mail` */
    readonly dir: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async send(message: MailMessage): Promise<MailResult> {
    const prepared = prepareMessage(message)
    if (wasRefused(prepared)) return prepared.refused
    const date = this.now()
    const id = newSortableId(date)
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(join(this.dir, `${id}.eml`), toEml(prepared, { id, date }))
      await writeFile(join(this.dir, `${id}.html`), prepared.html)
    } catch (err) {
      return { ok: false, retry: true, reason: 'transient', detail: (err as Error).name }
    }
    return { ok: true, providerId: id }
  }

  /** The messages written, newest first (at most `limit`). */
  async list(limit = 50): Promise<StoredMail[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const ids = names
      .filter(n => n.endsWith('.eml'))
      .map(n => n.slice(0, -'.eml'.length))
      .sort()
      .reverse()
      .slice(0, limit)
    const out: StoredMail[] = []
    for (const id of ids) {
      const headers = parseEmlHeaders(await readFile(join(this.dir, `${id}.eml`), 'utf8'))
      out.push({
        id,
        to: headers.To ?? '',
        from: parseAddress(headers.From ?? ''),
        subject: decodeWords(headers.Subject ?? ''),
        date: headers.Date ?? '',
        headers,
      })
    }
    return out
  }

  /** The `.eml` or `.html` of one message, or null. */
  async read(id: string, kind: 'eml' | 'html'): Promise<string | null> {
    if (!/^[0-9a-v]+$/.test(id)) return null
    try {
      return await readFile(join(this.dir, `${id}.${kind}`), 'utf8')
    } catch {
      return null
    }
  }
}
