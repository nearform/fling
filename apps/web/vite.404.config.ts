import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The standalone 404 the sites distribution serves as /_fling/404.html on every site host. One
// self-contained file — CSS and JS inlined, no public dir, no asset URLs — because it is served
// from arbitrary hosts where no relative or absolute path would resolve.
export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  publicDir: false,
  build: {
    outDir: 'dist-404',
    emptyOutDir: true,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    rollupOptions: { input: '404.html' },
  },
})
