import { defineConfig } from "vite";

// JSX settings come from tsconfig.json (react-jsx with preact as the import source). The widget (embed.html) is
// its own entry so it loads only what it needs.
export default defineConfig({
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, rollupOptions: { input: { main: "index.html", embed: "embed.html" } } },
  server: { proxy: { "/api": "http://127.0.0.1:8790" } },
});
