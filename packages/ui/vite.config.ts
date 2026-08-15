import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/__agent-context-trimmer/api": "http://127.0.0.1:8765",
    },
  },
});
