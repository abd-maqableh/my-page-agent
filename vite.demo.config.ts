import { defineConfig } from 'vite'

// Demo-only config: serves index.html + src/main.ts during local development.
// Does not affect the published library build (see vite.config.ts).
export default defineConfig({
  root: __dirname,
  publicDir: 'public',
  server: {
    port: 5173,
  },
})
