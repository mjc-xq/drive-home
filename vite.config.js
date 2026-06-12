import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The shipping format is ONE self-contained HTML file (dist/index.html) that runs
// inside the Claude app's artifact webview: every asset (scene data, aerial jpeg,
// ferrari.glb, draco decoder) must end up inlined — hence the huge inline limit.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  assetsInclude: ['**/*.glb'],
  build: {
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
    target: 'es2019'
  },
  test: {
    environment: 'node'
  }
});
