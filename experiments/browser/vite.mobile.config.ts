// Staged into the vendored checkout. Extends its config with a self-signed
// certificate and LAN binding, both required to test on a phone: WebGPU is
// only exposed in a secure context, and http:// on a LAN address is not one.
import { mergeConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import base from './vite.config';

export default mergeConfig(base, {
  plugins: [basicSsl()],
  server: { host: true, https: {} },
});
