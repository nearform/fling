import type { Context } from 'hono'
import type { z } from 'zod'
import { badRequest } from './errors.ts'

/** Parse the JSON body with a schema (ZodError → 400 via the error handler). */
export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw badRequest('Body must be JSON', 'invalid_json')
  }
  return schema.parse(raw)
}
