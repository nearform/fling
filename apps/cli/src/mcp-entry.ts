/**
 * Entry point of the Claude Desktop extension (mcpb/manifest.json): runs the local MCP server over
 * stdio. Bundled self-contained by scripts/build-mcpb.mjs. The extension passes its settings as env:
 * FLING_URL (server) and FLING_DOWNLOADS_DIR (where file names are looked up).
 */
import { runMcpServer } from './mcp.ts'

await runMcpServer()
