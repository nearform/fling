/**
 * Local development's clock: the system's, moved on by an offset, so a local run (and the e2e
 * scenario) can see what happens days from now (the archive policy's warnings, archives, deletes
 * and purges) without waiting. `buildDeps` (deps.ts) gives it to an instance only with the dev
 * login on, which production never has, and only `POST /dev/clock` (routes/dev.ts, mounted only
 * then) moves it. One per runtime: a Node process, or a Worker isolate under wrangler dev.
 */
import type { Clock } from '../types.ts'

export class DevClock implements Clock {
  /** how far ahead of the system's clock it runs, in ms (never behind) */
  offsetMs = 0

  now(): Date {
    return new Date(Date.now() + this.offsetMs)
  }

  /** Move it on by `ms` (only forward: time that went back would undo what the API stored). */
  advance(ms: number) {
    this.offsetMs += Math.max(0, ms)
  }
}

/** The runtime's dev clock (see the header). */
export const devClock = new DevClock()
