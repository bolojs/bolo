/** Create-next-app (Pages Router) starter tree as an inline JSON file tree,
 * in the `mount()`/FileSystemTree shape the bolo container consumes. Exported
 * so the /ide subsite (and tests) can offer a Next template without copying
 * files around. */

export interface FileNode {
  readonly file: { readonly contents: string };
}

export interface DirectoryNode {
  readonly directory: Record<string, TreeNode>;
}

export type TreeNode = FileNode | DirectoryNode;

const file = (contents: string): FileNode => ({ file: { contents } });

export const nextTemplate: Record<string, TreeNode> = {
  "package.json": file(
    JSON.stringify(
      {
        name: "bolo-next-app",
        version: "0.1.0",
        private: true,
        scripts: { dev: "next dev" },
        dependencies: {
          next: "16.4.6",
          react: "^19.2.0",
          "react-dom": "^19.2.0",
        },
      },
      null,
      2,
    ),
  ),
  "next.config.js": file(
    '/** @type {import("next").NextConfig} */\nconst nextConfig = {};\nmodule.exports = nextConfig;\n',
  ),
  "tsconfig.json": file(
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "dom.iterable", "esnext"],
          jsx: "preserve",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
      },
      null,
      2,
    ),
  ),
  pages: {
    directory: {
      "_app.tsx": file(
        `import type { AppProps } from "next/app";
import "../styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
`,
      ),
      "_document.tsx": file(
        `import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
`,
      ),
      "index.tsx": file(
        `import Head from "next/head";
import Link from "next/link";

export default function Home() {
  return (
    <>
      <Head>
        <title>Create Next App</title>
      </Head>
      <main>
        <h1>Welcome to Next.js on bolo</h1>
        <p>
          Get started by editing <code>pages/index.tsx</code>
        </p>
        <Link href="/about">About page</Link>
      </main>
    </>
  );
}
`,
      ),
      "about.tsx": file(
        `export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p>This page proves filesystem routing works.</p>
    </main>
  );
}
`,
      ),
      blog: {
        directory: {
          "[id].tsx": file(
            `export default function Post({ title }: { title: string }) {
  return (
    <main>
      <h1>{title}</h1>
    </main>
  );
}

export async function getStaticProps({ params }: { params: { id: string } }) {
  return { props: { title: \`Post #\${params.id}\` } };
}
`,
          ),
        },
      },
      api: {
        directory: {
          "hello.ts": file(
            `import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ message: "Hello from the bolo Next API" });
}
`,
          ),
        },
      },
    },
  },
  styles: {
    directory: {
      "globals.css": file(
        `body { margin: 0; font-family: system-ui, sans-serif; }\nmain { padding: 2rem; }\n`,
      ),
    },
  },
};
