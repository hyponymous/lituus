import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: '/lituus/',
  build: { outDir: '../dist', emptyOutDir: true },
});
