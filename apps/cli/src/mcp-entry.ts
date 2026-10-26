/**
 * Entry point of the Claude Desktop extension (mcpb/manifest.json): runs the local MCP server over
 * stdio. Bundled self-contained by scripts/build-mcpb.mjs. The extension passes as env
 * FLING_DOWNLOADS_DIR (its setting: where file names are looked up) and, in the copy a Fling
 * serves, FLING_ADD_SERVER (that Fling's address, remembered on start).
 */
import { runMcpServer } from './mcp.ts'

await runMcpServer()
