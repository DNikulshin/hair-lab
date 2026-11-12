import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/app/main.ts' },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
});
