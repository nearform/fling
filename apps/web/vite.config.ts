import { createReadStream, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Dev only: serve the Claude Desktop extension built by `pnpm --filter @nearform/fling build:mcpb`
// (in production CI uploads it to the ui bucket at /downloads/fling.mcpb).
const mcpb = fileURLToPath(new URL('../cli/dist/fling.mcpb', import.meta.url))
const devDownloads = (): Plugin => ({
  name: 'fling-dev-downloads',
  configureServer(server) {
    server.middlewares.use('/downloads/fling.mcpb', (_req, res, next) => {
      if (!existsSync(mcpb)) return next()
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="fling.mcpb"')
      createReadStream(mcpb).pipe(res)
    })
  },
})

// `FLING_API_URL` points the dev proxy at another API (default: `pnpm dev`'s on :3001).
const API = process.env.FLING_API_URL ?? 'http://localhost:3001'

// The app: served from S3 at the root of fling.labs.nearform.com (CloudFront does the SPA
// fallback). In dev, everything the API answers in production is proxied to it.
export default defineConfig({
  plugins: [react(), devDownloads()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    // lvh.me resolves to 127.0.0.1 (IPv4); vite's default localhost bind can be IPv6-only.
    host: '127.0.0.1',
    strictPort: true,
    // The dev API sets APP_ORIGIN to http://fling.lvh.me:<port> (see apps/api/src/dev.ts).
    allowedHosts: ['.lvh.me'],
    // Keys are prefix matches unless they start with ^, so `/auth/` (not `/auth`) keeps the SPA's
    // /authorize consent page out of the proxy — the same split CloudFront's `/auth/*` makes.
    proxy: {
      '/api/': { target: API, changeOrigin: false },
      '/auth/': { target: API, changeOrigin: false },
      // Remote MCP connector: the MCP endpoint, the OAuth server and its discovery documents.
      '/mcp': { target: API, changeOrigin: false },
      '/oauth/': { target: API, changeOrigin: false },
      '/.well-known/': { target: API, changeOrigin: false },
    },
  },
})
