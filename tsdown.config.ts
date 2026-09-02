import { defineConfig } from 'tsdown'

/** Bundle the host entries (guard + archive-cut compaction backend); types
 * come from the tsc pass. */
export default defineConfig({
  entry: ['src/index.ts', 'src/compaction.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  clean: true,
})
