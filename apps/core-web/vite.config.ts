import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        headers: { Origin: "http://127.0.0.1:3000" },
      },
      "/auth": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        headers: { Origin: "http://127.0.0.1:3000" },
      },
    },
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
