import { defineConfig } from 'tsdown'

/** Bundle the single host entry; types come from the tsc pass. */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  clean: true,
})
