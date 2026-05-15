import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['@avant-garde/mastra-self-learning'],
});
