import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The app's entry, build and Worker (see wrangler.jsonc). Card code comes from the shared/
// submodule, and ../../public/assets is a symlink to its art.
const here = dir => fileURLToPath(new URL(dir, import.meta.url));

export default defineConfig({
  root: here('.'),
  plugins: [react()],
  publicDir: here('../../public'),
  server: {
    port: 5174,
    fs: { allow: [here('../..')] },
    proxy: {
      // In dev, read the live feed (GET only) so the app has real data.
      '/api/feed': { target: 'https://opval.dimas.works', changeOrigin: true },
      // Roster data is public and read-only too: read the live sources.
      '/api/roster': { target: 'https://opval.dimas.works', changeOrigin: true },
      // Accounts and saves run on a local Worker with a local database: `npm run call:api`.
      '/api/auth': 'http://localhost:8787',
      '/api/save': 'http://localhost:8787',
      '/api/leaderboard': 'http://localhost:8787',
      '/api/bingo': 'http://localhost:8787',
      '/api/weekly-bingo': 'http://localhost:8787',
      '/api/game': 'http://localhost:8787',
      '/api/transfer-bets': 'http://localhost:8787',
      '/api/profile': 'http://localhost:8787',
    },
  },
  build: {
    outDir: here('dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
  },
});
