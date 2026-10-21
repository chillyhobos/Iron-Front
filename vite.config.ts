import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    watch: {
      // The project lives in a OneDrive folder, where file-change notifications
      // can get lost and the dev server keeps serving an old copy of a file.
      // Polling checks for changes itself, so edits always show up.
      usePolling: true,
      interval: 250,
    },
    // Online play: pass the game's WebSocket through to the game server (npm run server).
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
