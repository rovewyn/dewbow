import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1", port: 5174, strictPort: true,
    proxy: Object.fromEntries(["/api", "/auth", "/health"].map(path => [path, {
      target: "http://127.0.0.1:3100", changeOrigin: true,
      headers: { Origin: "http://127.0.0.1:3100" },
    }])),
  },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
});
