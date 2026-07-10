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
      "/setup": "http://localhost:3456",
      "/anthropic": "http://localhost:3456",
      "/v1": "http://localhost:3456",
    },
  },
});
