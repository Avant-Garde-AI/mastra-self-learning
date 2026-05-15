import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'processors/index': 'src/processors/index.ts',
    'skills/index': 'src/skills/index.ts',
    'memory/index': 'src/memory/index.ts',
    'harness/index': 'src/harness/index.ts',
    'tools/index': 'src/tools/index.ts',
    'workflows/index': 'src/workflows/index.ts',
    'evals/index': 'src/evals/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  clean: true,
  external: ['@mastra/core', '@mastra/memory'],
  sourcemap: true,
  treeshake: true,
});
