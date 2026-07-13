import { createSignal, onMount } from "solid-js";
import { animate } from "motion";
import { boot, type BrowserContainer } from "@browser-containers/runtime";
import Terminal from "./Terminal";
import Editor from "./Editor";
import starterPackageJson from "./starter/package.json?raw";
import starterIndexJs from "./starter/index.js?raw";

type BootState = "booting" | "installing" | "ready" | "error";

export default function App() {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [lines, setLines] = createSignal<string[]>([]);
  const [source, setSource] = createSignal(starterIndexJs);
  let container: BrowserContainer | undefined;

  const appendLine = (s: string) => setLines((prev) => [...prev, s]);

  const runCommand = async (command: string, args: string[]) => {
    if (!container) return;
    appendLine(`\r\n\x1b[2m~/demo $ ${[command, ...args].join(" ")}\x1b[0m\r\n`);
    const proc = container.spawn(command, args);
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
    const exitCode = await proc.exit;
    appendLine(`\r\n\x1b[2mexit ${exitCode}\x1b[0m\r\n`);
  };

  onMount(async () => {
    try {
      container = await boot({
        workdirName: "/home/web",
        swPath: `${import.meta.env.BASE_URL}sw.js`,
      });

      await container.mount({
        "package.json": { file: { contents: starterPackageJson } },
        "index.js": { file: { contents: starterIndexJs } },
      });

      setBootState("installing");
      appendLine("\x1b[2m~/demo $ npm install\x1b[0m\r\n");
      const installProc = container.spawn("npm", ["install", "--ignore-scripts"]);
      const reader = installProc.output.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          appendLine(value);
        }
      } finally {
        reader.releaseLock();
      }
      await installProc.exit;

      setBootState("ready");
    } catch (e) {
      console.error("[demo] Boot failed:", e);
      setBootState("error");
    }
  });

  const runIndex = async () => {
    if (!container) return;
    await container.fs.writeFile(`${container.workdir}/index.js`, source());
    await runCommand("node", ["index.js"]);
  };

  const listFiles = () => runCommand("ls", ["-l"]);

  const pressAnimate = (el: HTMLButtonElement) => {
    el.addEventListener("pointerdown", () => animate(el, { scaleX: 0.96, scaleY: 0.96 }, { duration: 0.1 }));
    el.addEventListener("pointerup", () => animate(el, { scaleX: 1, scaleY: 1 }, { duration: 0.15, ease: "easeOut" }));
    el.addEventListener("pointerleave", () => animate(el, { scaleX: 1, scaleY: 1 }, { duration: 0.15, ease: "easeOut" }));
  };

  return (
    <div class="app">
      <header class="app-header">
        <span class="app-title">browser-containers</span>
        <span class={`app-status app-status--${bootState()}`}>{bootState()}</span>
      </header>
      <main class="app-panels">
        <Editor value={source()} onChange={setSource} />
        <section class="output-col">
          <Terminal lines={lines()} />
          <div class="quick-actions">
            <button ref={pressAnimate} disabled={bootState() !== "ready"} onClick={runIndex}>
              Run index.js
            </button>
            <button ref={pressAnimate} disabled={bootState() !== "ready"} onClick={listFiles}>
              List files
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
