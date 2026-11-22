import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so that the built index.html loads correctly from file:// inside Electron.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
