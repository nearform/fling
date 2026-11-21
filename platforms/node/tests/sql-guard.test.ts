/**
 * A guard on the SQL in platforms/node/src: values reach Postgres only as `$n` parameters.
 *
 * What it catches, in every .ts file under src (comments skipped):
 * - a **SQL template** (a template literal whose text has a SQL keyword, matched case-insensitively)
 *   interpolating anything but: a call of `ident(`, `qualified(`, `int(` or `limitSql(` (ident.ts,
 *   and LIMIT through `int`); `this.items` (assigned once, from `qualified`); `where.join(' AND ')`
 *   (fragments held to the next rule); a ternary between two upper-case literals (`ASC`/`DESC`);
 *   or a placeholder's number (`$${n}`, `$${params.length}`);
 * - a **fragment** (a template literal with a `$${…}` placeholder, such as those pushed onto
 *   `where`) interpolating anything but placeholder numbers;
 * - **concatenation**: a string or template literal holding a SQL keyword joined with `+` to an
 *   operand that isn't a literal.
 *
 * What it doesn't catch: SQL text that holds no keyword and no placeholder until it is put
 * together elsewhere (a fragment in a plain string, joined with `.concat()` or an array `join`
 * other than `where`'s), SQL built outside platforms/node/src, or a value passed through a helper
 * on the allowlist that doesn't do what its name says. ident.ts and its tests cover the helpers;
 * review covers the rest.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const KEYWORD =
  /\b(select|insert|update|delete|create|drop|alter|listen|unlisten|notify|set|where|limit|order by|returning|values)\b/i

/** What a SQL template may interpolate. */
const ALLOWED_IN_SQL: RegExp[] = [
  /^(ident|qualified|int|limitSql)\(/,
  /^this\.items$/,
  /^where\.join\(' AND '\)$/,
  /^[\w.]+ \? '[A-Z]+' : '[A-Z]+'$/,
]
/** A placeholder's number: what follows `$` in `$${…}`. */
const PLACEHOLDER = /^(n|params\.length)$/

interface Literal {
  kind: 'string' | 'template'
  start: number
  end: number
  text: string
  /** `${…}` expressions, with whether each is a placeholder's number (`$${…}`) */
  expressions: { code: string; placeholder: boolean }[]
}

/** The string and template literals in `source`, nested templates included. */
function literals(source: string): Literal[] {
  const out: Literal[] = []
  let i = 0
  const readString = (quote: string) => {
    const start = i
    i++
    while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1
    i++
    out.push({
      kind: 'string',
      start,
      end: i,
      text: source.slice(start + 1, i - 1),
      expressions: [],
    })
  }
  const readTemplate = (): void => {
    const lit: Literal = { kind: 'template', start: i, end: i, text: '', expressions: [] }
    out.push(lit)
    i++
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        lit.text += source.slice(i, i + 2)
        i += 2
      } else if (source[i] === '$' && source[i + 1] === '{') {
        const placeholder = source[i - 1] === '$'
        lit.text += '${}'
        i += 2
        const from = i
        let depth = 1
        while (i < source.length && depth > 0) {
          const c = source[i] as string
          if (c === '`') readTemplate()
          else if (c === "'" || c === '"') readString(c)
          else {
            if (c === '{') depth++
            if (c === '}') depth--
            i++
          }
        }
        lit.expressions.push({ code: source.slice(from, i - 1).trim(), placeholder })
      } else {
        lit.text += source[i]
        i++
      }
    }
    i++
    lit.end = i
  }
  while (i < source.length) {
    const c = source[i] as string
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 2
    } else if (c === "'" || c === '"') readString(c)
    else if (c === '`') readTemplate()
    else i++
  }
  return out
}

/** What the guard finds wrong in `source`, one line each. */
function unsafe(source: string): string[] {
  const found: string[] = []
  for (const lit of literals(source)) {
    const sql = KEYWORD.test(lit.text)
    for (const e of lit.expressions) {
      if (
        e.placeholder ? PLACEHOLDER.test(e.code) : sql && ALLOWED_IN_SQL.some(a => a.test(e.code))
      ) {
        continue
      }
      if (sql || lit.expressions.some(x => x.placeholder)) found.push(`\${${e.code}}`)
    }
    if (!sql) continue
    // Concatenation with something that isn't a literal, on either side.
    const after = source.slice(lit.end).match(/^\s*\+\s*(\S)/)
    const before = source.slice(0, lit.start).match(/(\S)\s*\+\s*$/)
    if (after && !['"', "'", '`'].includes(after[1] as string)) found.push(`${lit.text} + …`)
    if (before && !['"', "'", '`'].includes(before[1] as string)) found.push(`… + ${lit.text}`)
  }
  return found
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []
  )
}

describe('SQL in platforms/node/src', () => {
  it('takes values only as parameters', () => {
    let sql = 0
    const found: string[] = []
    for (const file of files(SRC)) {
      const source = readFileSync(file, 'utf8')
      sql += literals(source).filter(l => KEYWORD.test(l.text)).length
      for (const f of unsafe(source)) found.push(`${relative(SRC, file)}: ${f}`)
    }
    expect(found).toEqual([])
    // The scan sees the Table's and the fan-out's SQL (it would pass vacuously otherwise).
    expect(sql).toBeGreaterThan(10)
  })

  it('catches a value spliced into SQL, however it is written', () => {
    const bad = [
      'db.query(`SELECT * FROM items WHERE pk = ${pk}`)',
      'db.query(`select * from items where pk = ${pk}`)',
      "db.query(`DELETE FROM ${this.items} WHERE sk = '${item.sk}'`)",
      'where.push(`sk > $${params.length} OR pk = ${pk}`)',
      'where.push(`sk ${op} $${n}`)',
      'db.query(`LISTEN ${channelFromRequest}`)',
      'db.query(`SELECT 1${limit ? ` LIMIT ${limit}` : ""}`)',
      "db.query('SELECT * FROM items WHERE pk = ' + pk)",
      "db.query(prefix + ' WHERE sk = $1', [sk])",
      'db.query(`ORDER BY sk ${direction}`)',
    ]
    for (const source of bad) expect(unsafe(source), source).not.toEqual([])
    const good = [
      'db.query(`SELECT 1 FROM ${this.items} WHERE pk = $1`, [pk])',
      "db.query(`SELECT 1 FROM ${qualified(s, 'items')} ` + 'WHERE pk = $1', [pk])",
      'where.push(`sk >= $${params.length}`)',
      "q(`ORDER BY sk ${opts.reverse ? 'DESC' : 'ASC'}${limitSql(limit)}`)",
      'throw new Error(`not a number: ${k}`)',
    ]
    for (const source of good) expect(unsafe(source), source).toEqual([])
  })
})
