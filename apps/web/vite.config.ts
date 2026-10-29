import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8090' } },
  build: {
    rollupOptions: {
      output: { manualChunks: { three: ['three'], 'graph-3d': ['react-force-graph-3d'], 'graph-2d': ['react-force-graph-2d'] } },
    },
    chunkSizeWarningLimit: 1000,
  },
});
