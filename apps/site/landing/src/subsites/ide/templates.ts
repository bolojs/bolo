/**
 * Starter templates for the /ide subsite. Each template is a full project
 * tree keyed by path relative to the container workdir; the IDE mounts it,
 * runs npm install, and serves it through the in-browser Vite server.
 */

import { nextTemplate, type TreeNode } from "@bolojs/next-server";

export interface IdeTemplate {
  id: string;
  /** Which in-browser dev server fronts the project. */
  kind: "vite" | "next";
  /** URL prefix the preview iframe loads (root-SW scope). */
  previewBase: string;
  /** File opened in the editor after mounting. */
  entry: string;
  name: string;
  description: string;
  /** Headline text the rendered app shows, used by e2e to assert the preview. */
  headline: string;
  files: Record<string, string>;
}

const packageJson = (name: string, extraDeps: Record<string, string> = {}) =>
  JSON.stringify(
    {
      name: `bolo-${name}`,
      private: true,
      type: "module",
      scripts: { dev: "vite" },
      dependencies: { ...extraDeps },
    },
    null,
    2,
  );

const viteReactFiles = (): Record<string, string> => ({
  "package.json": packageJson("ide-react", {
    react: "^19.1.0",
    "react-dom": "^19.1.0",
    vite: "^6.3.5",
  }),
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React on bolo</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
`,
  "src/App.tsx": `export default function App() {
  return (
    <main>
      <h1>Hello from React + Vite on bolo!</h1>
      <p>Edit src/App.tsx and the preview reloads.</p>
    </main>
  );
}
`,
  "src/styles.css": `:root {
  color-scheme: light;
  font-family: system-ui, sans-serif;
}

body {
  margin: 0;
}

main {
  display: grid;
  min-height: 100vh;
  place-content: center;
  text-align: center;
}

h1 {
  font-size: 2rem;
  letter-spacing: -0.03em;
  margin: 0 0 0.5rem;
}

p {
  color: #666;
  margin: 0;
}
`,
});

export const IDE_TEMPLATES: IdeTemplate[] = [
  {
    id: "vite-react",
    kind: "vite",
    previewBase: "/__preview/",
    entry: "src/App.tsx",
    name: "Vite + React",
    description: "TypeScript, TSX transform and live preview served by the in-browser Vite server.",
    headline: "Hello from React + Vite on bolo!",
    files: viteReactFiles(),
  },
];

const flattenTree = (tree: Record<string, TreeNode>, prefix = ""): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if ("file" in node) out[path] = node.file.contents;
    else Object.assign(out, flattenTree(node.directory, path));
  }
  return out;
};

const nextFiles = (): Record<string, string> => {
  const files = flattenTree(nextTemplate);
  // `next` itself is emulated by NextDevServer (shims serve next/*), so the
  // install only needs React; drop the real dependency to keep install fast.
  files["package.json"] = packageJson("ide-next", { react: "^19.1.0", "react-dom": "^19.1.0" });
  return files;
};

IDE_TEMPLATES.push({
  id: "next-pages",
  kind: "next",
  previewBase: "/__next/",
  entry: "pages/index.tsx",
  name: "Next.js (Pages Router)",
  description:
    "Filesystem routes, getStaticProps and an API route served by the in-browser Next dev server.",
  headline: "Welcome to Next.js on bolo",
  files: nextFiles(),
});
