import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/target/**", "**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2021",
    rollupOptions: {
      output: {
        manualChunks: { terminal: ["@xterm/xterm", "@xterm/addon-fit"] },
      },
    },
  },
});
