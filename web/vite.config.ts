import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.DATAQORE_CONTROLLER_URL ?? "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  preview: {
    proxy: {
      "/api": {
        target: process.env.DATAQORE_CONTROLLER_URL ?? "http://127.0.0.1:3000",
      },
    },
  },
});
