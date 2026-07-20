import { useCallback, useEffect, useRef, useState } from "react";
import { boot, type BrowserContainer } from "bolojs";
import { starterTree } from "./scaffold";
import { loadProjectSnapshot, restoreProjectSnapshot, saveProjectSnapshot } from "./persist";

const PROJECT_ID = "default";

export type ContainerStatus = "booting" | "installing" | "ready" | "error";

export interface TerminalLine {
  text: string;
}

export function useContainer() {
  const [status, setStatus] = useState<ContainerStatus>("booting");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [container, setContainer] = useState<BrowserContainer | null>(null);
  const containerRef = useRef<BrowserContainer | null>(null);

  const appendLine = useCallback((s: string) => setLines((prev) => [...prev, s]), []);

  const runToCompletion = useCallback(async (proc: ReturnType<BrowserContainer["spawn"]>) => {
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
  }, [appendLine]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setStatus("booting");
      const container = await boot({ workdirName: "/home/web", swPath: "/sw.js" });
      if (cancelled) {
        await container.teardown();
        return;
      }
      containerRef.current = container;
      setContainer(container);
      container.on("server-ready", (_port, url) => setPreviewUrl(new URL(url, location.origin).href));

      const snap = await loadProjectSnapshot(PROJECT_ID);
      if (snap) {
        restoreProjectSnapshot(snap);
      } else {
        await container.mount(starterTree);
      }

      setStatus("installing");
      appendLine("\x1b[2m~/project $ npm install\x1b[0m\r\n");
      await runToCompletion(container.spawn("npm", ["install", "--ignore-scripts"]));
      await saveProjectSnapshot(PROJECT_ID);

      setStatus("ready");
    })().catch(() => {
      if (!cancelled) setStatus("error");
    });

    return () => {
      cancelled = true;
      containerRef.current?.teardown();
      containerRef.current = null;
    };
  }, [appendLine, runToCompletion]);

  const runCommand = useCallback(
    async (command: string, args: string[]) => {
      const container = containerRef.current;
      if (!container) return 1;
      appendLine(`\r\n\x1b[2m~/project $ ${[command, ...args].join(" ")}\x1b[0m\r\n`);
      const exitCode = await runToCompletion(container.spawn(command, args));
      appendLine(`\r\n\x1b[2mexit ${exitCode}\x1b[0m\r\n`);
      await saveProjectSnapshot(PROJECT_ID);
      return exitCode;
    },
    [appendLine, runToCompletion],
  );

  return {
    container,
    status,
    previewUrl,
    lines,
    runCommand,
    appendLine,
    saveSnapshot: () => saveProjectSnapshot(PROJECT_ID),
  };
}
