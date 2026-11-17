/** @jsxImportSource solid-js */
import "../../demo/client-globals";
import { createSignal, getOwner, onMount, runWithOwner } from "solid-js";
import type { JSX } from "solid-js";
import * as v from "valibot";
import { getLogger } from "@bolojs/log/browser";
import type { BrowserContainer, ReplResult } from "@bolojs/runtime";
import type { SWSandbox } from "@bolojs/sandbox";
import { bootSubsite, getBootedVfs } from "../shared/boot";
import { installSwErrorTracking } from "../shared/sw-handlers";
import Editor, { type EditorDocument } from "../ui/Editor";
import Terminal from "../ui/Terminal";
import WorkbenchShell from "../workbench/WorkbenchShell";
import { createWorkbenchTabs } from "../workbench/tabs";
import type { PanelView, SidebarView, StatusItem } from "../workbench/types";
import { AppBackend, VIRTUAL_BASE, type BackendFs, type RouteSummary } from "./backend";
import { apiFetch, toVirtualPath } from "./client";
import { schemaForPath } from "./contract";
import {
  clearRouteSnapshot,
  loadRouteSnapshot,
  routeSnapshot,
  saveRouteSnapshot,
} from "./persistence";
import { STARTER_PACKAGE_JSON, STARTER_ROUTES } from "./starter";

const logger = getLogger(["bolo", "site-landing", "subsite", "app"]);

type BootState = "booting" | "ready" | "error";
type ApplyState = "idle" | "saving" | "applied";

const statusLabels: Record<BootState, string> = {
  booting: "booting…",
  ready: "ready",
  error: "error",
};

const statusDotStyles: Record<BootState, string> = {
  booting: "bg-muted animate-pulse",
  ready: "bg-[var(--success)]",
  error: "bg-[var(--danger)]",
};

interface ResponseView {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  /** Contract validation result for JSON bodies on known routes. */
  contract: { checked: boolean; ok: boolean; issue?: string };
}

const emptyResponse: ResponseView = {
  status: 0,
  statusText: "",
  headers: [],
  body: "",
  contract: { checked: false, ok: false },
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

const codeTabId = (path: string) => `code:${path}`;
const fileName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/**
 * The /app workbench on the shared shell: a "Backend routes" explorer
 * sidebar (opens a request tab pre-filled with the route's method/path plus
 * a code tab for its handler file, the Postman "open folder" move), the
 * request builder as the strip's main tab, and the terminal in the
 * collapsible bottom panel.
 *
 * Backend wiring is unchanged from the pre-shell subsite: route files live
 * in the container VFS, AppBackend reloads them as blob modules, and the
 * sw-sandbox virtual origin serves them live on save.
 */
export default function AppWorkbench() {
  const [bootState, setBootState] = createSignal<BootState>("booting");
  const [applyState, setApplyState] = createSignal<ApplyState>("idle");
  const [routes, setRoutes] = createSignal<RouteSummary[]>([]);
  const [documents, setDocuments] = createSignal<EditorDocument[]>([]);
  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [method, setMethod] = createSignal<string>("GET");
  const [url, setUrl] = createSignal<string>(`${VIRTUAL_BASE}/api/v1/items`);
  const [reqHeaders, setReqHeaders] = createSignal<string>("");
  const [reqBody, setReqBody] = createSignal<string>("");
  const [sending, setSending] = createSignal(false);
  const [response, setResponse] = createSignal<ResponseView>(emptyResponse);
  const [termLines, setTermLines] = createSignal<string[]>([]);
  const [replActive, setReplActive] = createSignal(false);
  const tabs = createWorkbenchTabs();

  let container: BrowserContainer | undefined;
  let routesDirPath: string | undefined;
  let backend: AppBackend | undefined;
  let applyTimer: ReturnType<typeof setTimeout> | undefined;
  let appliedTimer: ReturnType<typeof setTimeout> | undefined;

  const openRouteFile = async (file: string) => {
    if (!container) return;
    const contents = await container.fs.readFile(file).catch(() => "");
    setDocuments((docs) =>
      docs.some((d) => d.path === file) ? docs : [...docs, { path: file, contents }],
    );
    setActivePath(file);
    const id = codeTabId(file);
    tabs.open({
      id,
      kind: "code",
      title: fileName(file),
      onClose: () => setDocuments((docs) => docs.filter((d) => d.path !== file)),
      render: () => <div class="h-full min-h-0">{tabs.activeId() === id ? editor() : null}</div>,
    });
  };

  const applyRoutes = async () => {
    if (!backend) return;
    try {
      setApplyState("saving");
      const list = await backend.reload();
      setRoutes(list);
      if (container && routesDirPath) {
        await saveRouteSnapshot(routeSnapshot(getBootedVfs(), routesDirPath));
      }
      setApplyState("applied");
      clearTimeout(appliedTimer);
      appliedTimer = setTimeout(() => setApplyState("idle"), 1500);
    } catch (err) {
      logger.error("route reload failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      setApplyState("idle");
    }
  };

  const handleEditorChange = (path: string, contents: string) => {
    setDocuments((docs) => docs.map((d) => (d.path === path ? { ...d, contents } : d)));
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      void container?.fs.writeFile(path, contents).then(applyRoutes);
    }, 400);
  };

  const resetRoutes = async () => {
    await clearRouteSnapshot();
    globalThis.location.reload();
  };

  const selectRoute = (route: RouteSummary) => {
    setMethod(route.method);
    setUrl(`${VIRTUAL_BASE}${route.path}`);
    // Opening the handler file activates its code tab; the request tab stays
    // one click away in the strip.
    void openRouteFile(route.file);
  };

  const send = async () => {
    setSending(true);
    try {
      const headers: Record<string, string> = {};
      for (const line of reqHeaders().split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      const res = await apiFetch({
        method: method(),
        path: url(),
        headers,
        body: reqBody(),
      });
      const raw = await res.text();
      let pretty = raw;
      let contract: ResponseView["contract"] = { checked: false, ok: false };
      try {
        const parsed: unknown = JSON.parse(raw);
        pretty = JSON.stringify(parsed, null, 2);
        const schema = schemaForPath(new URL(toVirtualPath(url()), location.origin).pathname);
        if (schema) {
          const result = v.safeParse(schema, parsed);
          contract = result.success
            ? { checked: true, ok: true }
            : { checked: true, ok: false, issue: v.summarize(result.issues) };
        }
      } catch {
        // Not JSON: show the raw body, no contract check.
      }
      setResponse({
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
        body: pretty,
        contract,
      });
    } catch (err) {
      setResponse({
        status: 0,
        statusText: "request failed",
        headers: [],
        body: err instanceof Error ? err.message : String(err),
        contract: { checked: false, ok: false },
      });
    } finally {
      setSending(false);
    }
  };

  const appendTerm = (s: string) => setTermLines((prev) => [...prev, s]);

  const runToCompletion = async (proc: ReturnType<BrowserContainer["spawn"]>) => {
    const reader = proc.output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        appendTerm(value);
      }
    } finally {
      reader.releaseLock();
    }
    return proc.exit;
  };

  const runTermCommand = async (command: string, args: string[]) => {
    if (!container) return;
    appendTerm(`\r\n\x1b[2m~/project $ ${[command, ...args].join(" ")}\x1b[0m\r\n`);
    const exitCode = await runToCompletion(container.spawn(command, args));
    appendTerm(`\r\n\x1b[2mexit ${exitCode}\x1b[0m\r\n`);
  };

  const enterRepl = async () => {
    if (!container) return;
    await container.startRepl();
    appendTerm('\r\n\x1b[2mWelcome to Node.js REPL. Type ".exit" to leave.\x1b[0m\r\n');
    setReplActive(true);
  };

  const handleReplLine = async (line: string): Promise<{ continuation?: boolean } | void> => {
    if (!container) return;
    if (line.trim() === ".exit") {
      container.exitRepl();
      setReplActive(false);
      appendTerm("\r\n");
      return;
    }
    const result: ReplResult = await container.evalRepl(line);
    if (result.error) {
      appendTerm(`\x1b[2m${result.error}\x1b[0m\r\n`);
    } else if (result.value !== undefined) {
      appendTerm(`${result.value}\r\n`);
    }
    return result.continuation ? { continuation: true } : {};
  };

  const handleTermSubmit = async (line: string): Promise<{ continuation?: boolean } | void> => {
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
    await runTermCommand(command, args);
  };

  onMount(() => {
    installSwErrorTracking();
    // The terminal is now always available in the bottom panel; greet on
    // first open instead of gating the whole pane behind a toggle.
    appendTerm(
      "\x1b[2mApp container terminal — node, npm, curl and git share the routes' VFS.\x1b[0m\r\n",
    );
    (async () => {
      try {
        container = await bootSubsite("app");

        // Seed the VFS with the starter backend on first boot. Route files
        // persist across reloads through the VfsBus OPFS layer.
        const fs = container.fs as unknown as BackendFs;
        const routesDir = `${container.workdir}/routes`;
        routesDirPath = routesDir;
        const saved = await loadRouteSnapshot();
        await fs.writeFile(`${container.workdir}/package.json`, STARTER_PACKAGE_JSON);
        if (saved) {
          for (const [path, contents] of Object.entries(saved)) {
            await fs.writeFile(path, contents);
          }
        } else {
          for (const route of STARTER_ROUTES) {
            await fs.writeFile(`${container.workdir}/${route.file}`, route.contents);
          }
        }

        backend = new AppBackend(fs, routesDir);
        const list = await backend.reload();
        setRoutes(list);

        // Serve the backend through the sw-sandbox virtual origin. The
        // handler only claims this subsite's virtual port; anything else
        // throws so other sandbox handlers (preview, node http) still run.
        const sandbox = (globalThis as unknown as { __sandbox?: SWSandbox }).__sandbox;
        sandbox?.onFetch((req) => {
          const pathname = new URL(req.url).pathname;
          if (!pathname.startsWith(`${VIRTUAL_BASE}/`) && pathname !== VIRTUAL_BASE) {
            throw new Error("not handled by /app backend");
          }
          if (!backend) throw new Error("backend not ready");
          return backend.handle(req);
        });

        setBootState("ready");
        const first = list.find((r) => r.file.endsWith("items.js")) ?? list[0];
        if (first) selectRoute(first);
      } catch (err) {
        logger.error("app subsite boot failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        console.error("[app] boot failed", err);
        setBootState("error");
      }
    })();
  });

  // One shared Editor reparented into the active code tab's body, so the
  // workbench strip owns file tabs while the Editor keeps its per-path
  // CodeMirror states. Created under this component's owner: an element
  // created inside a conditional branch is disposed with it.
  const activeCodePath = () => {
    const id = tabs.activeId();
    return id?.startsWith("code:") ? id.slice("code:".length) : null;
  };

  const owner = getOwner();
  let editorEl: JSX.Element | undefined;
  const editor = () =>
    (editorEl ??= runWithOwner(owner, () => (
      <Editor
        documents={documents()}
        activePath={activeCodePath()}
        showTabs={false}
        onSelect={() => {}}
        onClose={(path) => tabs.close(codeTabId(path))}
        onChange={handleEditorChange}
      />
    )));

  const sidebarViews: SidebarView[] = [
    {
      id: "routes",
      title: "Backend routes",
      width: 260,
      render: () => (
        <div data-panel="routes" class="flex h-full min-h-0 flex-col overflow-hidden">
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <ul class="flex flex-col gap-1">
              {routes().map((route) => (
                <li>
                  <button
                    type="button"
                    data-route-file={route.file}
                    class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--surface-2)]"
                    classList={{ "bg-[var(--surface-2)]": activePath() === route.file }}
                    onClick={() => selectRoute(route)}
                  >
                    <span class="rounded bg-[var(--accent-dim)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--accent)]">
                      {route.method}
                    </span>
                    <span class="truncate font-mono text-[11px]">{route.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div class="shrink-0 border-t border-border p-2">
            <button
              type="button"
              data-testid="reset-routes"
              onClick={() => void resetRoutes()}
              class="w-full rounded-lg border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:text-[var(--fg)]"
            >
              Reset to starter routes
            </button>
            <p class="mt-2 text-[11px] leading-relaxed text-muted">
              Edit a handler, then hit send. Saves apply live through the service worker, no
              restart.
            </p>
          </div>
        </div>
      ),
    },
  ];

  const requestTab = () => (
    <div data-panel="request" class="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3">
      <div class="flex shrink-0 items-center gap-2">
        <select
          data-testid="method"
          value={method()}
          onChange={(e) => setMethod(e.currentTarget.value)}
          class="rounded-lg border border-border bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none"
        >
          {METHODS.map((m) => (
            <option value={m}>{m}</option>
          ))}
        </select>
        <input
          data-testid="url"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          spellcheck={false}
          class="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          data-testid="send"
          disabled={sending() || bootState() !== "ready"}
          onClick={() => void send()}
          class="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-[12px] font-medium text-white transition-opacity disabled:opacity-50"
        >
          {sending() ? "Sending…" : "Send"}
        </button>
      </div>
      <textarea
        data-testid="req-headers"
        value={reqHeaders()}
        onInput={(e) => setReqHeaders(e.currentTarget.value)}
        placeholder={"Headers, one per line\ncontent-type: application/json"}
        spellcheck={false}
        class="h-16 shrink-0 resize-none rounded-lg border border-border bg-transparent px-2 py-1.5 font-mono text-[11px] outline-none placeholder:text-muted"
      />
      <textarea
        data-testid="req-body"
        value={reqBody()}
        onInput={(e) => setReqBody(e.currentTarget.value)}
        placeholder="Request body (non-GET)"
        spellcheck={false}
        class="min-h-0 flex-1 resize-none rounded-lg border border-border bg-transparent px-2 py-1.5 font-mono text-[11px] outline-none placeholder:text-muted"
      />
      <div class="flex h-44 shrink-0 flex-col overflow-hidden rounded-lg border border-border">
        <ResponseMeta response={response()} />
        <pre
          data-testid="response-body"
          class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px]"
        >
          {response().body || "Send a request to see the response body."}
        </pre>
      </div>
    </div>
  );

  onMount(() => {
    tabs.open({
      id: "request",
      kind: "request",
      title: "Request",
      closable: false,
      render: () => requestTab(),
    });
  });

  const bottomPanels: PanelView[] = [
    {
      id: "terminal",
      title: "Terminal",
      render: () => (
        <Terminal
          lines={termLines()}
          disabled={bootState() !== "ready"}
          onSubmit={handleTermSubmit}
        />
      ),
    },
  ];

  const statusItems: StatusItem[] = [
    {
      id: "boot-state",
      side: "left",
      render: () => (
        <span class="flex items-center gap-2">
          <span
            class={`size-2 rounded-full transition-colors duration-500 ${statusDotStyles[bootState()]}`}
          />
          <span>{statusLabels[bootState()]}</span>
          {applyState() === "applied" && <span data-testid="applied">routes applied</span>}
        </span>
      ),
    },
    {
      id: "terminal-toggle",
      side: "right",
      render: (ctx) => (
        <button
          type="button"
          aria-expanded={ctx.panelVisible()}
          class="rounded px-1.5 py-0.5 transition-colors hover:text-fg"
          classList={{ "text-fg": ctx.panelVisible() }}
          onClick={() => ctx.togglePanel()}
        >
          Terminal
        </button>
      ),
    },
  ];

  return (
    <WorkbenchShell
      subsite="app"
      panels={["routes", "editor", "request", "response", "terminal"]}
      bootState={bootState()}
      attrs={{ "data-apply-state": applyState }}
      sidebar={sidebarViews}
      tabs={tabs}
      bottom={bottomPanels}
      status={statusItems}
    />
  );
}

const ResponseMeta = (props: { response: ResponseView }) => {
  const res = () => props.response;
  return (
    <div class="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2">
      <span data-testid="response-status" class="font-mono text-[12px] font-medium">
        {res().status ? `${res().status} ${res().statusText}` : "No response yet"}
      </span>
      {res().contract.checked && (
        <span
          data-testid="contract-badge"
          classList={{
            "text-[var(--success)]": res().contract.ok,
            "text-[var(--danger)]": !res().contract.ok,
          }}
          class="text-[11px]"
        >
          {res().contract.ok
            ? "matches contract"
            : `contract mismatch${res().contract.issue ? `: ${res().contract.issue}` : ""}`}
        </span>
      )}
    </div>
  );
};
