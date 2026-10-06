import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Built straight into the web server's public folder, so `pnpm --filter @ghl-lk/web dev`
 * serves the console with no second process. `base` matches where the server
 * mounts it; assets land under /admin/assets/.
 *
 * In development (`pnpm --filter @ghl-lk/admin dev`) API calls proxy to the web
 * server, which keeps the session cookie same-origin.
 */
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: { outDir: "../web/public/admin-app", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, proxy: { "/admin/api": "http://localhost:3000", "/admin/login": "http://localhost:3000", "/admin/logout": "http://localhost:3000" } },
});
