/** @jsxImportSource solid-js */
import "../../demo/client-globals";
import { createSignal, onMount } from "solid-js";
import * as v from "valibot";
import { getLogger } from "@bolojs/log/browser";
import type { BrowserContainer } from "@bolojs/runtime";
import type { SWSandbox } from "@bolojs/sandbox";
import { bootSubsite } from "../shared/boot";
import { installSwErrorTracking } from "../shared/sw-handlers";
import Editor, { type EditorDocument } from "../ui/Editor";
import SplitPane from "../ui/SplitPane";
import { AppBackend, VIRTUAL_BASE, type BackendFs, type RouteSummary } from "./backend";
import { apiFetch, toVirtualPath } from "./client";
import { schemaForPath } from "./contract";
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

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * The /app subsite: a Postman/Data Studio style full-stack demo where the
 * frontend and backend both run in the browser. Left: the backend route
 * editor (route files persisted in the container VFS, executed live on
 * save). Right: request builder plus response viewer, talking to the
 * backend through the sw-sandbox virtual origin.
 */
export default function AppSubsite() {
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

  let container: BrowserContainer | undefined;
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
  };

  const applyRoutes = async () => {
    if (!backend) return;
    try {
      setApplyState("saving");
      const list = await backend.reload();
      setRoutes(list);
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

  const selectRoute = (route: RouteSummary) => {
    setMethod(route.method);
    setUrl(`${VIRTUAL_BASE}${route.path}`);
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
            : { checked: true, ok: false, issue: v.summarize(result.issues)[0]?.message };
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

  onMount(() => {
    installSwErrorTracking();
    (async () => {
      try {
        container = await bootSubsite("app");

        // Seed the VFS with the starter backend on first boot. Route files
        // persist across reloads through the VfsBus OPFS layer.
        const fs = container.fs as unknown as BackendFs;
        const routesDir = `${container.workdir}/routes`;
        if (!(await fs.exists(routesDir))) {
          await fs.mkdir(routesDir, { recursive: true });
          await fs.writeFile(`${container.workdir}/package.json`, STARTER_PACKAGE_JSON);
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
        setBootState("error");
      }
    })();
  });

  const routeList = () => (
    <div data-panel="routes" class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted">
        Backend routes
      </div>
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
        <p class="mt-3 px-2 text-[11px] leading-relaxed text-muted">
          Edit a handler, then hit send. Saves apply live through the service worker,
          no restart.
        </p>
      </div>
    </div>
  );

  const requestBuilder = () => (
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
    </div>
  );

  const responseViewer = () => {
    const res = response();
    return (
      <div data-panel="response" class="flex h-full min-h-0 flex-col overflow-hidden">
        <div class="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2">
          <span data-testid="response-status" class="font-mono text-[12px] font-medium">
            {res.status ? `${res.status} ${res.statusText}` : "No response yet"}
          </span>
          {res.contract.checked && (
            <span
              data-testid="contract-badge"
              classList={{
                "text-[var(--success)]": res.contract.ok,
                "text-[var(--danger)]": !res.contract.ok,
              }}
              class="text-[11px]"
            >
              {res.contract.ok
                ? "matches contract"
                : `contract mismatch${res.contract.issue ? `: ${res.contract.issue}` : ""}`}
            </span>
          )}
        </div>
        <div class="max-h-28 shrink-0 overflow-y-auto border-b border-border px-3 py-2">
          {res.headers.length === 0 ? (
            <p class="text-[11px] text-muted">Response headers appear here.</p>
          ) : (
            <dl class="flex flex-col gap-0.5">
              {res.headers.map(([name, value]) => (
                <div class="flex gap-2 font-mono text-[11px]">
                  <dt class="shrink-0 text-muted">{name}:</dt>
                  <dd class="break-all">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <pre
          data-testid="response-body"
          class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px]"
        >
          {res.body || "Send a request to see the response body."}
        </pre>
      </div>
    );
  };

  return (
    <div
      data-subsite="app"
      data-panels="routes editor request response"
      data-boot-state={bootState()}
      data-apply-state={applyState()}
      class="flex h-full min-h-0 flex-col gap-2 overflow-hidden"
    >
      <div class="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-[var(--surface-2)] shadow-sm">
        <SplitPane
          direction="row"
          initialRatio={0.45}
          dataPanel="workbench"
          first={
            <SplitPane
              direction="column"
              initialRatio={0.3}
              dataPanel="routes-editor"
              first={routeList()}
              second={
                <Editor
                  documents={documents()}
                  activePath={activePath()}
                  onSelect={setActivePath}
                  onClose={(path) =>
                    setDocuments((docs) => docs.filter((d) => d.path !== path))
                  }
                  onChange={handleEditorChange}
                />
              }
            />
          }
          second={
            <SplitPane
              direction="column"
              initialRatio={0.45}
              dataPanel="request-response"
              first={requestBuilder()}
              second={responseViewer()}
            />
          }
        />
      </div>
      <div class="flex shrink-0 items-center justify-end gap-2 text-[12px] leading-none text-muted">
        <span
          class="size-2 rounded-full transition-colors duration-500"
          classList={{ [statusDotStyles[bootState()]]: true }}
        />
        <span>{statusLabels[bootState()]}</span>
        {applyState() === "applied" && <span data-testid="applied">routes applied</span>}
      </div>
    </div>
  );
}
