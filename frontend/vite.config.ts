import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/files': 'http://localhost:3000',
      '/preview-ports': {
        target: 'http://127.0.0.1:45700',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/preview-ports\/\d+/, ''),
      },
    },
  },
});
