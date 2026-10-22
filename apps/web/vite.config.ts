import { defineConfig } from "vite";

// JSX settings come from tsconfig.json (react-jsx with preact as the import source).
export default defineConfig({
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8790" } },
});
