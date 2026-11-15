/**
 * The parts of the Workers runtime's `cloudflare:workers` module the Worker uses: entrypoints a
 * dynamically loaded site server is handed (src/servers/entrypoints.ts) and the Worker's own
 * exports, from which they are made with props. The Worker's types otherwise come from
 * @cloudflare/workers-types by import, which leaves module declarations out.
 */
declare module 'cloudflare:workers' {
  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected env: Env
    protected ctx: { props: Props; waitUntil(promise: Promise<unknown>): void }
    constructor(ctx: unknown, env: Env)
  }
  /** The Worker's exported entrypoints, each callable with props to make a binding of it. */
  export const exports: Record<string, (options: { props: unknown }) => unknown>
}
