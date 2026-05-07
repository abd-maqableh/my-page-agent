/// <reference types="vitest" />
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'node:path'

export default defineConfig({
  publicDir: false,
  plugins: [
    dts({
      entryRoot: 'src',
      include: ['src/index.ts', 'src/core/**/*.ts', 'src/llm/**/*.ts', 'src/page-controller/**/*.ts', 'src/ui/**/*.ts'],
      exclude: ['src/main.ts', 'src/test/**', 'src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
      tsconfigPath: resolve(__dirname, 'tsconfig.lib.json'),
      rollupTypes: true,
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'PageAgent',
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },
    rollupOptions: {
      external: ['ollama', 'ollama/browser'],
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/test/**/*.test.ts'],
  },
})
