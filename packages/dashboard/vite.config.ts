import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 3457,
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:3456",
    },
  },
});
