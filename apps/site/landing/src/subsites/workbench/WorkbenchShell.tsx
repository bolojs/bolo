/** @jsxImportSource solid-js */
import { createRenderEffect, createSignal, For, getOwner, onMount, runWithOwner } from "solid-js";
import type { JSX } from "solid-js";
import SplitPane from "../ui/SplitPane";
import ActivityRail from "./ActivityRail";
import TabStrip from "./TabStrip";
import BottomPanel from "./BottomPanel";
import StatusBar from "./StatusBar";
import type { WorkbenchContext, WorkbenchShellProps } from "./types";

/**
 * VSCode-style workbench shell: activity rail + contextual sidebar | tabbed
 * main area over a collapsible bottom panel, over a status bar. The shell
 * owns chrome only — runtime state stays in each subsite and is injected
 * through the view/tab/status render closures (see types.ts).
 *
 * Region elements are built lazily-once (the `once` getters) so their DOM —
 * xterm, CodeMirror, iframes — survives collapse/expand reparenting and is
 * never created while `placeholder` is shown (pre-boot, when a subsite's
 * container may not exist yet). They are created under the shell's own
 * owner: elements made inside a conditional branch are disposed with that
 * branch, which would silently kill their onMount/onCleanup state.
 */
export default function WorkbenchShell(props: WorkbenchShellProps) {
  const sidebarViews = () => props.sidebar ?? [];
  const bottomPanels = () => props.bottom ?? [];
  const [viewId, setViewId] = createSignal<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = createSignal(true);
  const [panelId, setPanelId] = createSignal<string | null>(null);
  const [panelVisible, setPanelVisible] = createSignal(true);
  let rootEl!: HTMLDivElement;

  const activeViewId = () => viewId() ?? sidebarViews()[0]?.id ?? null;
  const activePanelId = () => panelId() ?? bottomPanels()[0]?.id ?? null;
  const showSidebar = () => sidebarViews().length > 0 && sidebarVisible();

  const ctx: WorkbenchContext = {
    sidebarVisible,
    toggleSidebar: () => setSidebarVisible((v) => !v),
    panelVisible,
    togglePanel: () => setPanelVisible((v) => !v),
  };

  const selectView = (id: string) => {
    if (activeViewId() === id) {
      setSidebarVisible((v) => !v);
    } else {
      setViewId(id);
      setSidebarVisible(true);
    }
  };

  const tabList = () => props.tabs?.tabs() ?? [];
  const activeTabId = () => props.tabs?.activeId() ?? null;
  const closeTab = (id: string) => {
    tabList()
      .find((tab) => tab.id === id)
      ?.onClose?.();
    props.tabs?.close(id);
  };

  const owner = getOwner();
  const once = (build: () => JSX.Element): (() => JSX.Element) => {
    let el: JSX.Element | undefined;
    return () => (el ??= runWithOwner(owner, build));
  };

  const sidebar = once(() => (
    <div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <For each={sidebarViews()}>
        {(view) => (
          <div
            classList={{
              hidden: view.id !== activeViewId(),
              "flex h-full min-h-0 flex-1 flex-col": view.id === activeViewId(),
            }}
          >
            <div class="shrink-0 px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">
              {view.title}
            </div>
            <div class="min-h-0 flex-1 overflow-hidden">{view.render()}</div>
          </div>
        )}
      </For>
    </div>
  ));

  const main = once(() => (
    <div data-panel="main" class="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {props.tabs ? (
        <>
          <TabStrip
            tabs={tabList()}
            activeId={activeTabId()}
            onActivate={(id) => props.tabs?.activate(id)}
            onClose={closeTab}
          />
          <div class="relative min-h-0 flex-1 overflow-hidden">
            <For each={tabList()}>
              {(tab) => (
                <div
                  classList={{
                    hidden: tab.id !== activeTabId(),
                    "h-full w-full": tab.id === activeTabId(),
                  }}
                >
                  {tab.render()}
                </div>
              )}
            </For>
          </div>
        </>
      ) : (
        (props.children ?? null)
      )}
    </div>
  ));

  const bottom = once(() => (
    <BottomPanel
      panels={bottomPanels()}
      activeId={activePanelId()}
      onSelect={setPanelId}
      onCollapse={() => setPanelVisible(false)}
    />
  ));

  const center = once(() => (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {bottomPanels().length > 0 && panelVisible() ? (
        <SplitPane
          direction="column"
          initialRatio={0.68}
          dataPanel="workbench-main"
          first={main()}
          second={bottom()}
        />
      ) : (
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">{main()}</div>
      )}
    </div>
  ));

  // Extra data-* attributes (e.g. data-project-state) applied imperatively
  // so accessor values stay reactive.
  onMount(() => {
    createRenderEffect(() => {
      for (const [name, value] of Object.entries(props.attrs ?? {})) {
        const resolved = typeof value === "function" ? value() : value;
        if (resolved == null) rootEl.removeAttribute(name);
        else rootEl.setAttribute(name, resolved);
      }
    });
  });

  return (
    <div
      ref={rootEl}
      data-subsite={props.subsite}
      data-panels={props.panels.join(" ")}
      data-boot-state={props.bootState}
      class="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-[var(--surface-2)]"
    >
      {props.placeholder ? (
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">{props.placeholder}</div>
      ) : (
        <div class="flex min-h-0 flex-1">
          {sidebarViews().length > 1 ? (
            <ActivityRail views={sidebarViews()} activeId={activeViewId()} onSelect={selectView} />
          ) : null}
          {showSidebar() ? (
            <SplitPane
              direction="row"
              initialRatio={Math.min(0.45, (sidebarViews()[0]?.width ?? 240) / 1100)}
              dataPanel="workbench"
              first={sidebar()}
              second={center()}
            />
          ) : (
            center()
          )}
        </div>
      )}
      <StatusBar items={props.status ?? []} ctx={ctx} />
    </div>
  );
}
