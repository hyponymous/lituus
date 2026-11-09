import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: '/lituus/',
  build: { outDir: '../dist', emptyOutDir: true },
  // Reachable from a phone through `tailscale serve`, which supplies the HTTPS
  // that WebGPU requires off localhost. Vite refuses unknown Host headers by
  // default; any tailnet's MagicDNS name ends in `.ts.net`. `vite preview`
  // inherits this.
  server: { allowedHosts: ['.ts.net'] },
});
