import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// The dev server and `vite preview` forward /api to the Fastify server, as Caddy does in production.
const api = { '/api': process.env.RXF_API_URL ?? 'http://127.0.0.1:3000' };

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@rxf/source', ...defaultClientConditions] },
  server: { proxy: api },
  preview: { proxy: api },
});
