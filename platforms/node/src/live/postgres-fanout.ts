/**
 * A live fan-out over Postgres LISTEN/NOTIFY: the processes of one instance that share a database
 * (the Node host on Fly.io, DigitalOcean, self-host) carry their live rooms' events to each other
 * through it, with no broker of its own. Each event is one `NOTIFY` on the instance's channel
 * (`fling_live_<schema>`, so instances sharing a database stay apart); each process holds one
 * connection that `LISTEN`s, and Postgres delivers a notification to every listener, the sender's
 * own included (the hub ignores its own).
 *
 * Delivery is Postgres's: at most once, in commit order, only while the listening connection is up.
 * A listener whose connection drops connects again after a pause; what was said meanwhile is lost,
 * as live rooms allow. A notification payload holds under 8000 bytes, and a room event is at most
 * a few kilobytes (LIVE_MESSAGE_MAX_BYTES), so nothing is split.
 */
import type { PGlite } from '@electric-sql/pglite'
import type { LiveEvent, LiveFanout } from '@fling/api/live-memory'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { drizzle as pglite } from 'drizzle-orm/pglite'
import type pg from 'pg'
import { DEFAULT_SCHEMA, schemaName } from '../table/items.ts'

/** Postgres's limit on a notification's payload, less a margin. */
const MAX_PAYLOAD = 7_900
/** How long a listener waits before connecting again. */
const RECONNECT_MS = 2_000

/** What the fan-out needs of a database: send a notification, listen on a channel. */
export interface Notifier {
  notify(channel: string, payload: string): Promise<void>
  /** calls `onPayload` for each notification on `channel` until the returned function is called */
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>
}

/** A `pg` Pool as a Notifier: notifications go out through the pool, one client listens. */
export function pgNotifier(pool: pg.Pool): Notifier {
  return {
    async notify(channel, payload) {
      await drizzle(pool).execute(sql`SELECT pg_notify(${channel}, ${payload})`)
    },
    async listen(channel, onPayload) {
      let stopped = false
      let client: pg.PoolClient | undefined
      const connect = async (): Promise<void> => {
        if (stopped) return
        let c: pg.PoolClient | undefined
        let dropped = false
        // This attempt's connection, gone (an error, or LISTEN failed): destroyed, never handed
        // back to the pool, and one more attempt after a pause. Once per attempt.
        const drop = (err: Error) => {
          if (dropped) return
          dropped = true
          if (c) c.release(err)
          if (client === c) client = undefined
          if (!stopped) setTimeout(() => void connect(), RECONNECT_MS)
        }
        try {
          c = await pool.connect()
          c.on('notification', n => {
            if (n.channel === channel && n.payload !== undefined) onPayload(n.payload)
          })
          c.on('error', drop)
          await drizzle(c).execute(sql`LISTEN ${sql.identifier(channel)}`)
          client = c
        } catch (err) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              msg: 'live fan-out: listen failed',
              error: String(err),
            })
          )
          drop(err instanceof Error ? err : new Error(String(err)))
        }
      }
      await connect()
      return async () => {
        stopped = true
        if (!client) return
        await drizzle(client)
          .execute(sql`UNLISTEN ${sql.identifier(channel)}`)
          .catch(() => {})
        client.release()
      }
    },
  }
}

/** PGlite as a Notifier (one process: the local runtime, tests). */
export function pgliteNotifier(db: PGlite): Notifier {
  return {
    async notify(channel, payload) {
      await pglite(db).execute(sql`SELECT pg_notify(${channel}, ${payload})`)
    },
    listen: (channel, onPayload) => db.listen(channel, onPayload),
  }
}

export class PostgresFanout implements LiveFanout {
  private readonly channel: string
  private stops: (() => Promise<void>)[] = []

  constructor(
    private notifier: Notifier,
    opts: { schema?: string } = {}
  ) {
    this.channel = `fling_live_${schemaName(opts.schema ?? DEFAULT_SCHEMA)}`
    // A channel is an identifier, which Postgres cuts at 63 bytes: the schema's name may be at
    // most 52 characters for it.
    if (this.channel.length > 63)
      throw new Error(`live channel identifier too long: ${this.channel}`)
  }

  async publish(event: LiveEvent) {
    const payload = JSON.stringify(event)
    if (Buffer.byteLength(payload) > MAX_PAYLOAD) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'live fan-out: event too large to send' }))
      return
    }
    await this.notifier.notify(this.channel, payload)
  }

  async subscribe(listener: (event: LiveEvent) => void) {
    this.stops.push(
      await this.notifier.listen(this.channel, payload => {
        try {
          listener(JSON.parse(payload) as LiveEvent)
        } catch {
          // not one of ours
        }
      })
    )
  }

  async close() {
    await Promise.all(this.stops.splice(0).map(stop => stop()))
  }
}
