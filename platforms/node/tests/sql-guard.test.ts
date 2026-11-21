/**
 * A guard on the SQL in platforms/node/src: Drizzle writes it, so values reach Postgres only as
 * parameters. Drizzle's query builder and its `sql` tagged template both send what they
 * interpolate as a parameter (or, for `sql.identifier`, quoted); what could still splice text in
 * is SQL Fling writes as a plain string. So, in every .ts file under src (comments skipped), this
 * catches:
 * - `sql.raw(` given anything but a single string literal;
 * - a plain (untagged) string or template literal that reads as SQL: its text opens a statement
 *   in any case (`select x`, `insert into`, `delete from`, `update t set`, `create`/`drop`/`alter`
 *   `table`/`schema`/`index`, `set x to`, `begin`, `with x as (`), or holds an upper-case keyword
 *   (`SELECT`, `FROM`, `WHERE`, `VALUES`, `ORDER BY`, `LIMIT`, `RETURNING`, `ON CONFLICT`,
 *   `LISTEN`, `UNLISTEN`, `NOTIFY`), which covers SQL put together by `+` or by interpolation.
 *
 * It doesn't catch SQL text with no such shape in any one literal (assembled from fragments that
 * each read as plain words, or lower-case `listen x`), or a `sql` template that interpolates `sql.raw(…)` of a variable held
 * elsewhere under another name. Review covers those.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** A statement's opening, in any case (shaped as SQL, so log messages and errors don't match). */
const STATEMENT =
  /^\s*(select\s+[\w$*"(]|insert\s+into\b|delete\s+from\b|update\s+\S+\s+set\b|(create|drop|alter)\s+(table|schema|index|extension|role)\b|set\s+(local\s+|session\s+)?[\w.]+\s+(to|=)|begin(\s+isolation\b|\s+transaction\b|\s*;|\s*$)|with\s+\w+\s+as\s*\()/i
/** Upper-case keywords: a clause, or a statement English rarely writes in capitals. */
const CLAUSE =
  /\b(FROM|WHERE|VALUES|ORDER BY|LIMIT|RETURNING|ON CONFLICT|LISTEN|UNLISTEN|NOTIFY|SELECT)\b/

/** What the guard finds wrong in `source`, one line each. */
function unsafe(source: string): string[] {
  const found: string[] = []
  let i = 0
  const tagBefore = (at: number) => /\bsql\s*$/.test(source.slice(Math.max(0, at - 8), at))
  const check = (text: string, tagged: boolean) => {
    if (!tagged && (STATEMENT.test(text) || CLAUSE.test(text))) found.push(text)
  }
  const readQuoted = (quote: string) => {
    const start = i++
    while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1
    i++
    return source.slice(start + 1, i - 1)
  }
  /** A template literal from its backtick; its text with each `${…}` as `${}`. */
  const readTemplate = (): string => {
    let text = ''
    i++
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        text += source.slice(i, i + 2)
        i += 2
      } else if (source[i] === '$' && source[i + 1] === '{') {
        text += '${}'
        i += 2
        let depth = 1
        while (i < source.length && depth > 0) {
          const c = source[i] as string
          if (c === '`') {
            const tagged = tagBefore(i)
            check(readTemplate(), tagged)
          } else if (c === "'" || c === '"') check(readQuoted(c), false)
          else {
            if (c === '{') depth++
            if (c === '}') depth--
            i++
          }
        }
      } else text += source[i++]
    }
    i++
    return text
  }
  while (i < source.length) {
    const c = source[i] as string
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 2
    } else if (source.startsWith('sql.raw(', i)) {
      i += 'sql.raw('.length
      const literal = source.slice(i).match(/^\s*('[^'\\]*'|"[^"\\]*")\s*\)/)
      if (!literal) found.push(`sql.raw(${source.slice(i, source.indexOf(')', i))})`)
    } else if (c === "'" || c === '"') check(readQuoted(c), false)
    else if (c === '`') {
      const tagged = tagBefore(i)
      check(readTemplate(), tagged)
    } else i++
  }
  return found
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []
  )
}

describe('SQL in platforms/node/src', () => {
  it('is written by Drizzle, with values only as parameters', () => {
    const found: string[] = []
    let tagged = 0
    for (const file of files(SRC)) {
      const source = readFileSync(file, 'utf8')
      tagged += source.match(/\bsql`/g)?.length ?? 0
      for (const f of unsafe(source)) found.push(`${relative(SRC, file)}: ${f}`)
    }
    expect(found).toEqual([])
    // The scan sees the Table's and the fan-out's SQL (it would pass vacuously otherwise).
    expect(tagged).toBeGreaterThan(5)
  })

  it('catches SQL written as a plain string, however it is put together', () => {
    const bad = [
      'db.query(`SELECT * FROM items WHERE pk = ${pk}`)',
      'db.query(`select * from items where pk = $1`, [pk])',
      "db.query('DELETE FROM items WHERE sk = ' + sk)",
      "db.query(prefix + ' WHERE sk = $1', [sk])",
      'c.query(`LISTEN ${channel}`)',
      'db.execute(sql.raw(`SET search_path TO ${schema}`))',
      'db.execute(sql.raw(name))',
    ]
    for (const source of bad) expect(unsafe(source), source).not.toEqual([])
    const good = [
      'db.execute(sql`SELECT pg_notify(${channel}, ${payload})`)',
      'db.execute(sql`LISTEN ${sql.identifier(channel)}`)',
      "db.execute(sql.raw('RESET search_path'))",
      'db.select().from(items).where(eq(items.pk, pk))',
      'throw new Error(`database schema must be lower-case letters: ${schema}`)',
      "console.warn('live fan-out: listen failed')",
    ]
    for (const source of good) expect(unsafe(source), source).toEqual([])
  })
})
