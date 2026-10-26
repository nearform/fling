import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The review shell the sites serve as /_fling/review.html on every site host (review-shell-main.ts).
// One self-contained file, like the 404 (vite.404.config.ts): it is served from arbitrary hosts
// where no asset path would resolve. No React: it only frames the site and draws pins over it.
export default defineConfig({
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  publicDir: false,
  build: {
    outDir: 'dist-review',
    emptyOutDir: true,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    rollupOptions: { input: 'review-shell.html' },
  },
})
