export declare const ROOT: string
export declare const TEMPLATE: string
export declare const MAX_PATHS_PER_SITE: number
export declare function parseJsonc(text: string): unknown
export declare function readJsonc(path: string): unknown
export declare const DEPLOY_KEYS: Record<string, string>
export declare function checkDeployConfig<T>(config: T): T
export declare function commonParent(a: string, b: string): string
export declare function renderWranglerConfig(
  template: unknown,
  config: unknown,
  outDir: string
): Record<string, unknown> & { name: string; routes: { pattern: string }[] }
export declare function checkMail(mail: unknown): void
export declare const MAIL_CRON: string
export declare function serversOn(instance: unknown): boolean
