import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dashboard is served by the gateway itself from `web/dist`, and in dev it
 * proxies API calls to the gateway so the UI runs with hot reload against a
 * real backend on port 8317.
 */
export default defineConfig({
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5317,
    proxy: {
      '/api': 'http://127.0.0.1:8317',
      '/v1': 'http://127.0.0.1:8317',
      '/health': 'http://127.0.0.1:8317',
      '/ready': 'http://127.0.0.1:8317',
      '/metrics': 'http://127.0.0.1:8317',
    },
  },
});
