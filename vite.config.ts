import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // 127.0.0.1, не localhost: IPv6-loopback режется правилом kill switch.
  // Сборка Rust (src-tauri/target) не для Vite: её файлы заняты cargo,
  // и наблюдатель падает с EBUSY.
  server: { host: "127.0.0.1", port: 1430, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
