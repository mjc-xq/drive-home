import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Normal multi-file build (no longer a single inlined artifact): big assets
// (aerial, GLBs) stay external and load lazily, photoreal 3D-tiles stream from
// Google, and the renderer/tiles libs code-split. The Google Maps key is read
// from .env.local (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) and surfaced to the client
// as import.meta.env.VITE_GOOGLE_MAPS_KEY by name only (value never in source).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const googleKey = env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';
  return {
    plugins: [react()],
    assetsInclude: ['**/*.glb'],
    define: {
      'import.meta.env.VITE_GOOGLE_MAPS_KEY': JSON.stringify(googleKey)
    },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 2_000,
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
            tiles: ['3d-tiles-renderer', '3d-tiles-renderer/plugins']
          }
        }
      }
    },
    test: { environment: 'node' }
  };
});
