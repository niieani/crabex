import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/__crabex/api": process.env.CRABEX_PROXY_ORIGIN ?? "http://127.0.0.1:8765",
    },
  },
});
