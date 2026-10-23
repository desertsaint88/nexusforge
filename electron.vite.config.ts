import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const shared = resolve(import.meta.dirname, 'src/shared')

// The production CSP is injected at build time only, so Vite's dev server
// (HMR websocket + React refresh preamble) keeps working in `npm run dev`.
function productionCsp(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: nexus-media: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
  return {
    name: 'nexusforge:csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
  }
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // Sandboxed preload scripts must be CommonJS.
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react(), tailwindcss(), productionCsp()]
  }
})
