import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The harness web talks to the Mastra server on :4111.
// VITE_SERVER_URL overrides for non-default setups.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
