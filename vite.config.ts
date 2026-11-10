import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server port is chosen by scripts/dev.mjs; Electron loads pages through the imageflow:// protocol,
// so the HMR client must connect to the dev server explicitly.
const port = Number(process.env.IMAGEFLOW_DEV_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port, strictPort: true,
    hmr: { protocol: 'ws', host: 'localhost', port, clientPort: port },
    // Project folders (samples, staged copies, test projects) reload through the app's own watcher.
    watch: { ignored: ['**/.build/**', '**/dist/**', '**/out/**', '**/sample/**', '**/spikes/**'] },
  },
  optimizeDeps: {
    entries: ['index.html'],
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'zod', 'mdast-util-from-markdown'],
  },
});
