import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import fs from "node:fs";
const root = path.resolve(__dirname, "..");
export default defineConfig({
  root,
  server: { port: 5174, strictPort: true },
  plugins: [
    react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } }),
    tailwindcss(),
    { name: "dyad-web-shim", transformIndexHtml: (html) => html.replace("<head>", '<head><script>' + fs.readFileSync(path.join(__dirname, "shim.js"), "utf8") + "</script>") },
  ],
  resolve: { alias: { "@": path.resolve(root, "src") } },
  define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: '"http://localhost:5174"' },
});
