/** @jsxImportSource solid-js */
import "../../demo/client-globals";
import { createSignal, onMount } from "solid-js";
import { getLogger } from "@bolojs/log/browser";
import type { BrowserContainer, ReplResult } from "@bolojs/runtime";
import { bootSubsite, getBootedVfs } from "./boot";
import { installSwErrorTracking, observePreviewUrl } from "./sw-handlers";
import Terminal from "../ui/Terminal";
import Editor, { type EditorDocument } from "../ui/Editor";
import Preview from "../ui/Preview";
import FileTree from "../ui/FileTree";
import SplitPane from "../ui/SplitPane";
import VibeApp from "../vibe/components/VibeApp";
import { vibeStarterTree } from "../vibe/scaffold";

declare global {
   
  var __preferLocalRolldown: boolean | undefined;
}

// See Demo.tsx: the esm.sh-hosted rolldown build panics in real browsers, so
// opt into the same-origin bundled dependency.
globalThis.__preferLocalRolldown = true;

const logger = getLogger(["bolo", "site-landing", "subsite"]);

export type SubsiteName = "ide" | "sandbox" | "app" | "vibe";

type BootState = "booting" | "installing" | "ready" | "error";

const statusLabels: Record<BootState, string> = {
  booting: "booting…",
  installing: "installing…",
  ready: "ready",
  error: "error",
};

const statusDotStyles: Record<BootState, string> = {
  booting: "bg-muted animate-pulse",
  installing: "bg-muted animate-pulse",
  ready: "bg-[var(--success)]",
  error: "bg-[var(--danger)]",
};

const starterPackageJson = (name: string) =>
  JSON.stringify({ name: `bolo-${name}`, private: true, type: "module" }, null, 2);

/** Flat per-subsite starter files (mounted at the workdir root). The vibe
 * subsite mounts a nested Vite + React tree instead (see vibeStarterTree). */
const STARTERS: Record<Exclude<SubsiteName, "vibe">, Record<string, string>> = {
  ide: {
    "package.json": starterPackageJson("ide"),
    "index.ts": 'console.log("Hello from the bolo IDE");\n',
    "server.ts":
      'import { createServer } from "node:http";\n\nconst server = createServer((_req, res) => {\n  res.end("hello from bolo");\n});\nserver.listen(3000, () => console.log("listening on 3000"));\n',
  },
  sandbox: {
    "package.json": starterPackageJson("sandbox"),
    "index.ts": 'console.log("Hello from the bolo sandbox");\n',
    "fib.js":
      "const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));\nconsole.log(fib(20));\n",
  },
  app: {
    "package.json": starterPackageJson("app"),
    "index.ts":
      'import { createServer } from "node:http";\n\nconst server = createServer((req, res) => {\n  res.writeHead(200, { "content-type": "application/json" });\n  res.end(JSON.stringify({ route: req.url, ok: true }));\n});\nserver.listen(3000, () => console.log("API listening on 3000"));\n',
  },
};

/** Which panels each subsite renders in its stub shell. */
const PANELS: Record<SubsiteName, string[]> = {
  ide: ["file-tree", "editor", "preview", "terminal"],
  sandbox: ["terminal"],
  app: ["editor", "preview", "terminal"],
  vibe: ["chat", "preview", "terminal"],
};

interface Props {
  subsite: SubsiteName;
}

export default function SubsiteApp(props: Props) {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  const [documents, setDocuments] = createSignal<EditorDocument[]>([]);
  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [lines, setLines] = createSignal<string[]>([]);
  const [inputValue, setInputValue] = createSignal("");
  const [replActive, setReplActive] = createSignal(false);
  let container: BrowserContainer | undefined;

  const appendLine = (s: string) => setLines((prev) => [...prev, s]);

  const runToCompletion = async (proc: ReturnType<BrowserContainer["spawn"]>) => {
    const reader = proc.output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        appendLine(value);
      }
    } finally {
      reader.releaseLock();
    }
    return proc.exit;
  };

  const openFile = async (path: string) => {
    if (!container) return;
    const contents = await container.fs.readFile(path).catch(() => "");
    setDocuments((docs) =>
      docs.some((d) => d.path === path) ? docs : [...docs, { path, contents }],
    );
    setActivePath(path);
  };

  const handleChange = (path: string, contents: string) => {
    setDocuments((docs) => docs.map((d) => (d.path === path ? { ...d, contents } : d)));
    void container?.fs.writeFile(path, contents).catch((err: unknown) => {
      logger.error("editor write failed", { error: err instanceof Error ? err.message : String(err) });
    });
  };

  const handleClose = (path: string) => {
    setDocuments((docs) => {
      const next = docs.filter((d) => d.path !== path);
      if (activePath() === path) setActivePath(next[next.length - 1]?.path ?? null);
      return next;
    });
  };

  onMount(() => {
    installSwErrorTracking();
    const isVibe = props.subsite === "vibe";

    (async () => {
      try {
        container = await bootSubsite(props.subsite);
        observePreviewUrl(container, setPreviewUrl);
        if (isVibe) {
          await container.mount(vibeStarterTree);
        } else {
          const starter = STARTERS[props.subsite as Exclude<SubsiteName, "vibe">];
          await container.mount(
            Object.fromEntries(
              Object.entries(starter).map(([name, contents]) => [
                name,
                { file: { contents } },
              ]),
            ),
          );
        }
        setBootState("installing");
        appendLine("\x1b[2m~/project $ npm install\x1b[0m\r\n");
        await runToCompletion(container.spawn("npm", ["install", "--ignore-scripts"]));
        appendLine("\r\n\x1b[2mexit 0\x1b[0m\r\n");
        setBootState("ready");
        if (isVibe) {
          await openFile(`${container.workdir}/src/App.jsx`);
        } else {
          const starter = STARTERS[props.subsite as Exclude<SubsiteName, "vibe">];
          const firstFile = Object.keys(starter).find((name) => name !== "package.json");
          if (firstFile) await openFile(`${container.workdir}/${firstFile}`);
        }
      } catch (err) {
        logger.error("subsite boot failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        setBootState("error");
      }
    })();
  });

  const runCommand = async (command: string, args: string[]) => {
    if (!container) return;
    appendLine(`\r\n\x1b[2m~/project $ ${[command, ...args].join(" ")}\x1b[0m\r\n`);
    const exitCode = await runToCompletion(container.spawn(command, args));
    appendLine(`\r\n\x1b[2mexit ${exitCode}\x1b[0m\r\n`);
  };

  const enterRepl = async () => {
    if (!container) return;
    await container.startRepl();
    appendLine("\r\n\x1b[2mWelcome to Node.js REPL. Type \".exit\" to leave.\x1b[0m\r\n");
    setReplActive(true);
  };

  const handleReplLine = async (line: string): Promise<{ continuation?: boolean } | void> => {
    if (!container) return;
    if (line.trim() === ".exit") {
      container.exitRepl();
      setReplActive(false);
      appendLine("\r\n");
      return;
    }
    const result: ReplResult = await container.evalRepl(line);
    if (result.error) {
      appendLine(`\x1b[2m${result.error}\x1b[0m\r\n`);
    } else if (result.value !== undefined) {
      appendLine(`${result.value}\r\n`);
    }
    return result.continuation ? { continuation: true } : {};
  };

  const handleSubmit = async (line: string): Promise<{ continuation?: boolean } | void> => {
    setInputValue("");
    if (!container) return;
    if (replActive()) return handleReplLine(line);
    const trimmed = line.trim();
    if (!trimmed) return;
    const [command, ...args] = trimmed.split(/\s+/);
    if (!command) return;
    if (command === "node" && args.length === 0) {
      await enterRepl();
      return;
    }
    await runCommand(command, args);
  };

  const terminal = () => (
    <Terminal
      lines={lines()}
      disabled={bootState() !== "ready"}
      inputValue={inputValue()}
      onSubmit={handleSubmit}
    />
  );

  const workbench = () => {
    switch (props.subsite) {
      case "sandbox":
        return terminal();
      case "ide":
        return (
          <SplitPane direction="row" initialRatio={0.2} dataPanel="workbench"
            first={
              bootState() === "ready" ? (
                <FileTree
                  vfs={getBootedVfs()}
                  root={container?.workdir ?? "/home/web"}
                  activePath={activePath()}
                  onSelect={(path) => void openFile(path)}
                  exclude={(path) => path.includes("node_modules") || path.includes("/.npm-cache/")}
                />
              ) : null
            }
            second={
              <SplitPane direction="column" initialRatio={0.68} dataPanel="workbench-main"
                first={
                  <SplitPane direction="row" initialRatio={0.55} dataPanel="editor-preview"
                    first={<Editor documents={documents()} activePath={activePath()} onSelect={setActivePath} onClose={handleClose} onChange={handleChange} />}
                    second={<Preview url={previewUrl()} />}
                  />
                }
                second={terminal()}
              />
            }
          />
        );
      case "app":
        return (
          <SplitPane direction="column" initialRatio={0.65} dataPanel="workbench"
            first={
              <SplitPane direction="row" initialRatio={0.5} dataPanel="editor-preview"
                first={<Editor documents={documents()} activePath={activePath()} onSelect={setActivePath} onClose={handleClose} onChange={handleChange} />}
                second={<Preview url={previewUrl()} />}
              />
            }
            second={terminal()}
          />
        );
      case "vibe":
        return (
          <SplitPane direction="row" initialRatio={0.35} dataPanel="workbench"
            first={
              <VibeApp
                getContainer={() => container}
                onOutput={appendLine}
                ready={bootState() === "ready"}
              />
            }
            second={
              <SplitPane direction="column" initialRatio={0.6} dataPanel="preview-terminal"
                first={<Preview url={previewUrl()} />}
                second={terminal()}
              />
            }
          />
        );
    }
  };

  return (
    <div
      data-subsite={props.subsite}
      data-panels={PANELS[props.subsite].join(" ")}
      data-boot-state={bootState()}
      class="flex h-full min-h-0 flex-col gap-2 overflow-hidden"
    >
      <div class="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-[var(--surface-2)] shadow-sm">
        {workbench()}
      </div>
      <div class="flex shrink-0 items-center justify-end gap-2 text-[12px] leading-none text-muted">
        <span class={`size-2 rounded-full transition-colors duration-500 ${statusDotStyles[bootState()]}`} />
        <span>{statusLabels[bootState()]}</span>
      </div>
    </div>
  );
}
