/**
 * Serve the benchmark pages on the LAN over HTTPS, for testing on a phone.
 *
 * HTTPS is not optional: WebGPU is exposed only in a secure context, and
 * `http://<lan-ip>` is not one — only `localhost` gets that exemption. Over
 * plain HTTP the phone would silently measure the CPU fallback.
 *
 *   node experiments/browser/serve.ts
 *
 * The certificate is self-signed, so Safari will interrupt with a warning the
 * first time: Show Details → visit this website. Then open /mobile.html.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { stage, shortName, VENDOR } from './stage.ts';

const PORT = 5199;

function lanAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

const nets: string[] = stage();
console.log(`serving nets: ${nets.map(shortName).join(', ')}`);
console.log(`\n  https://${lanAddress()}:${PORT}/mobile.html\n`);
console.log('Self-signed certificate: Safari will warn once. Show Details → visit this website.');
console.log('The page reports whether it got WebGPU before you run anything — check that first.\n');

const server: ChildProcess = spawn(
  'npm', ['run', 'dev', '--', '--config', 'vite.mobile.config.ts', '--port', String(PORT), '--strictPort'],
  { cwd: VENDOR, stdio: 'inherit' },
);
process.on('SIGINT', () => { server.kill(); process.exit(0); });
