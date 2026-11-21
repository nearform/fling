/**
 * The one way anything but a fixed fragment gets into this package's SQL. Values are always `$n`
 * parameters; an identifier (a schema, a table, a LISTEN channel) goes through `ident`, which
 * accepts only lower-case letters, digits and `_` (at most 63, Postgres's limit) and double-quotes
 * the result, so even a reserved word is only a name. Integers spliced in (a LIMIT) go through
 * `int`. tests/sql-guard.test.ts fails if SQL text interpolates anything else.
 */

const NAME = /^[a-z_][a-z0-9_]{0,62}$/

/** Whether `name` is an identifier `ident` takes. */
export const isIdentifier = (name: string) => NAME.test(name)

/** `name` as a quoted SQL identifier; throws for anything but `[a-z_][a-z0-9_]{0,62}`. */
export function ident(name: string): string {
  if (!isIdentifier(name)) {
    throw new Error(`not an identifier (lower-case letters, digits and _, at most 63): ${name}`)
  }
  return `"${name}"`
}

/** `schema.table`, both quoted. */
export const qualified = (schema: string, table: string) => `${ident(schema)}.${ident(table)}`

/** A safe integer as SQL text (a LIMIT); throws for anything else. */
export function int(n: number): string {
  if (!Number.isSafeInteger(n)) throw new Error(`not an integer: ${n}`)
  return String(n)
}
