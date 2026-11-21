/**
 * Every SQL string in platforms/node/src interpolates only what can't carry a value: identifiers
 * through ident.ts, integers through `int`, and fixed fragments built in code. Values are `$n`
 * parameters. A template literal counts as SQL when its text has a SQL keyword or a `$${…}`
 * placeholder; each `${…}` in one must be on ALLOWED, so an edit that splices a value into SQL
 * fails here before it can ship.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** What a SQL template may interpolate: the helpers and the fixed fragments. */
const ALLOWED: RegExp[] = [
  /^this\.items$/, // qualified(schema, 'items'): ident.ts
  /^schemaSql$/, // ident(schema)
  /^ident\((channel|'[a-z_]+')\)$/,
  /^int\((limit \+ 1|size)\)$/,
  /^limitSql\(limit\)$/, // ` LIMIT ${int(…)}` or nothing
  /^order$/, // 'ASC' | 'DESC'
  /^bound\.op$/, // CursorOp: '>' | '<' | '<='
  /^where\.join\(' AND '\)$/, // fixed conditions, each holding only `$n` placeholders
  /^params\.length$/, // the n of a `$n` placeholder
]

const SQL =
  /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|LISTEN|UNLISTEN|NOTIFY|SET|WHERE|LIMIT|ORDER BY)\b|\$\$\{/

interface Template {
  text: string
  expressions: string[]
}

/** The template literals in `source`, their text and their `${…}` expressions (nested ones too). */
function templates(source: string): Template[] {
  const out: Template[] = []
  let i = 0
  const skipString = (quote: string) => {
    i++
    while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1
    i++
  }
  const readTemplate = (): void => {
    i++ // the opening backtick
    const t: Template = { text: '', expressions: [] }
    out.push(t)
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') {
        t.text += source.slice(i, i + 2)
        i += 2
      } else if (source[i] === '$' && source[i + 1] === '{') {
        t.text += '${'
        i += 2
        const start = i
        let depth = 1
        while (i < source.length && depth > 0) {
          const c = source[i] as string
          if (c === '`') readTemplate()
          else if (c === "'" || c === '"') skipString(c)
          else {
            if (c === '{') depth++
            if (c === '}') depth--
            i++
          }
        }
        t.expressions.push(source.slice(start, i - 1).trim())
        t.text += '}'
      } else {
        t.text += source[i]
        i++
      }
    }
    i++ // the closing backtick
  }
  while (i < source.length) {
    const c = source[i] as string
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 2
    } else if (c === "'" || c === '"') skipString(c)
    else if (c === '`') readTemplate()
    else i++
  }
  return out
}

/** The `${…}` in SQL templates of `source` that aren't on ALLOWED. */
function unsafe(source: string): string[] {
  return templates(source)
    .filter(t => SQL.test(t.text))
    .flatMap(t => t.expressions.filter(e => !ALLOWED.some(a => a.test(e))))
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []
  )
}

describe('SQL in platforms/node/src', () => {
  it('interpolates nothing but identifiers, integers and fixed fragments', () => {
    let sql = 0
    const found: string[] = []
    for (const file of files(SRC)) {
      const source = readFileSync(file, 'utf8')
      sql += templates(source).filter(t => SQL.test(t.text)).length
      for (const e of unsafe(source)) found.push(`${relative(SRC, file)}: \${${e}}`)
    }
    expect(found).toEqual([])
    // The scan sees the Table's and the fan-out's SQL (it would pass vacuously otherwise).
    expect(sql).toBeGreaterThan(10)
  })

  it('catches a value spliced into SQL, however it is written', () => {
    const bad = [
      'db.query(`SELECT * FROM items WHERE pk = ${pk}`)',
      "db.query(`DELETE FROM ${this.items} WHERE sk = '${item.sk}'`)",
      'where.push(`sk > $${params.length} OR pk = ${pk}`)',
      'db.query(`LISTEN ${channelFromRequest}`)',
      'db.query(`SELECT 1${limit ? ` LIMIT ${limit}` : ""}`)',
    ]
    for (const source of bad) expect(unsafe(source), source).not.toEqual([])
    expect(unsafe('db.query(`SELECT 1 FROM ${this.items} WHERE pk = $1`, [pk])')).toEqual([])
    expect(unsafe('throw new Error(`not a number: ${k}`)')).toEqual([])
  })
})
