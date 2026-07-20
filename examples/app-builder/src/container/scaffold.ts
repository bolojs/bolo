import type { FileSystemTree } from "bolojs";

export const starterTree: FileSystemTree = {
  "package.json": {
    file: {
      contents: JSON.stringify(
        {
          name: "app-builder-project",
          private: true,
          type: "module",
          scripts: {
            dev: "vite",
          },
          dependencies: {
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          devDependencies: {
            "@vitejs/plugin-react": "^6.0.3",
            vite: "^8.0.0",
          },
        },
        null,
        2,
      ),
    },
  },
  "vite.config.js": {
    file: {
      contents: `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`,
    },
  },
  "index.html": {
    file: {
      contents: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>My App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
    },
  },
  src: {
    directory: {
      "main.jsx": {
        file: {
          contents: `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\n\ncreateRoot(document.getElementById("root")).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
        },
      },
      "App.jsx": {
        file: {
          contents: `export default function App() {\n  return (\n    <div style={{ fontFamily: "sans-serif", padding: "2rem" }}>\n      <h1>Hello, world!</h1>\n      <p>Ask the assistant to change this page.</p>\n    </div>\n  );\n}\n`,
        },
      },
    },
  },
};
