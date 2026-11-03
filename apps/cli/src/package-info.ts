/** Package metadata — bin name and version come from package.json (esbuild inlines it). */
import pkg from '../package.json'

export const PACKAGE_NAME: string = pkg.name
export const VERSION: string = pkg.version
/** The Node.js versions the CLI supports (`engines.node`, e.g. `>=22`). */
export const NODE_ENGINE: string = pkg.engines.node
export const BIN_NAME: string = Object.keys(pkg.bin)[0] ?? 'fling'
/** How a user without a global install runs the CLI — used in hints shown to agents. */
export const NPX_COMMAND = `npx ${pkg.name}`
