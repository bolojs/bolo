import { createSignal, onMount, onCleanup } from "solid-js";
import { boot, type BrowserContainer, type ShellResult } from "@browser-containers/runtime";
import Terminal from "./Terminal";
import Preview from "./Preview";
import starterMainJsx from "./starter/src/main.jsx?raw";
import starterAppJsx from "./starter/src/App.jsx?raw";

type BootState = "booting" | "ready" | "error";

declare global {
  interface Window {
    __browserbox: {
      install(pkgs?: string[]): Promise<ShellResult>;
      vfs: {
        writeFile(path: string, content: string): Promise<void>;
        exists(path: string): Promise<boolean>;
        mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
        readFile(path: string): Promise<string>;
      };
      preview: { loadUrl(url: string): void };
      shell: { exec(cmd: string): Promise<ShellResult> };
      vite: { transform(path: string): Promise<string> };
      boot: typeof boot;
      container?: BrowserContainer;
    };
    __browserbox_ready: boolean;
  }
}

function parseCommand(cmd: string): { command: string; args: string[] } {
  const tokens = cmd.trim().split(/\s+/);
  return { command: tokens[0] ?? "", args: tokens.slice(1) };
}

async function readStream(
  stream: ReadableStream<string>,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout(value);
    }
    return 0;
  } finally {
    reader.releaseLock();
  }
}

export default function App() {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [previewUrl, setPreviewUrl] = createSignal("");
  let container: BrowserContainer | undefined;

  onMount(async () => {
    try {
      container = await boot({
        workdirName: "/home/web",
        swPath: `${import.meta.env.BASE_URL}sw.js`,
      });

      const unsubPort = container.on("port", (_port, type, url) => {
        if (type === "open") {
          setPreviewUrl(url);
        }
      });

      const resolveVfsPath = (path: string) => {
        if (path.startsWith("/")) {
          return container!.workdir + path;
        }
        return path;
      };

      window.__browserbox = {
        install: async (pkgs?: string[]) => {
          const { command, args } = parseCommand(`npm install ${pkgs?.join(" ") ?? ""}`);
          const proc = container!.spawn(command, args);
          const exitCode = await proc.exit;
          return { exitCode, stdout: "", stderr: "" };
        },
        vfs: {
          writeFile: (path: string, content: string) =>
            container!.fs.writeFile(resolveVfsPath(path), content),
          exists: (path: string) => container!.fs.exists(resolveVfsPath(path)),
          mkdir: (path: string, options?: { recursive?: boolean }) =>
            container!.fs.mkdir(resolveVfsPath(path), options),
          readFile: (path: string) => container!.fs.readFile(resolveVfsPath(path)),
        },
        preview: { loadUrl: (url: string) => setPreviewUrl(url) },
        shell: {
          exec: async (cmd: string) => {
            const { command, args } = parseCommand(cmd);
            const proc = container!.spawn(command, args);
            const exitCode = await proc.exit;
            return { exitCode, stdout: "", stderr: "" };
          },
        },
        vite: {
          transform: async (path: string) => {
            const res = await fetch(`/__preview${path}`);
            return res.text();
          },
        },
        boot,
        container,
      };
      window.__browserbox_ready = true;

      // Mount the real React starter (apps/demo/src/starter) as the workdir tree.
      await container.mount({
        "package.json": {
          file: {
            contents: JSON.stringify(
              {
                name: "starter-app",
                type: "module",
                scripts: {
                  dev: "vite",
                },
                dependencies: {
                  react: "^18.2.0",
                  "react-dom": "^18.2.0",
                },
                devDependencies: {
                  vite: "^5.0.0",
                },
              },
              null,
              2,
            ),
          },
        },
        "index.html": {
          file: {
            contents: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Starter React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`,
          },
        },
        src: {
          directory: {
            "main.jsx": { file: { contents: starterMainJsx } },
            "App.jsx": { file: { contents: starterAppJsx } },
          },
        },
      });

      // Auto-install and auto-start dev server
      const installProc = container.spawn("npm", ["install", "--ignore-scripts"]);
      await installProc.exit;

      const devProc = container.spawn("npm", ["run", "dev"]);
      // Fire-and-forget; output stream is consumed by the runtime
      void devProc.exit;

      setBootState("ready");

      onCleanup(() => {
        unsubPort();
      });
    } catch (e) {
      console.error("[demo] Boot failed:", e);
      setBootState("error");
    }
  });

  const execute = async (
    cmd: string,
    stdout: (s: string) => void,
    stderr: (s: string) => void,
  ): Promise<ShellResult> => {
    if (!container) return Promise.reject(new Error("Not ready"));
    const { command, args } = parseCommand(cmd);
    const proc = container.spawn(command, args);
    const exitCode = await readStream(proc.output, stdout, stderr);
    return { exitCode, stdout: "", stderr: "" };
  };

  return (
    <div class="app">
      <header class="app-header">
        <span class="app-title">browser-containers</span>
        <span class={`app-status app-status--${bootState()}`}>{bootState()}</span>
      </header>
      <main class="app-panels">
        <Terminal onCommand={execute} disabled={bootState() !== "ready"} />
        <Preview url={previewUrl()} />
      </main>
    </div>
  );
}
