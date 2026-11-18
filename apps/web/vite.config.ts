import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// The dev server and `vite preview` forward /api to the Fastify server, as Caddy does in production. The Host
// header stays as the browser sent it (Vite's shorthand would rewrite it), because the server compares it
// with Origin on every state-changing request (ADR 0005).
const api = { '/api': { target: process.env.RXF_API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@rxf/source', ...defaultClientConditions] },
  server: { proxy: api },
  preview: { proxy: api },
});
