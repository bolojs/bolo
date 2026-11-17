import { createSignal } from "solid-js";
import type { WorkbenchTab, WorkbenchTabsController } from "./types";

/**
 * Open-tab list + active-tab state for the workbench shell. Kept tiny on
 * purpose: tab bodies render inside the shell, so the controller only owns
 * ordering and activation.
 */
export const createWorkbenchTabs = (initial: WorkbenchTab[] = []): WorkbenchTabsController => {
  const [tabs, setTabs] = createSignal<WorkbenchTab[]>(initial);
  const [activeId, setActiveId] = createSignal<string | null>(initial[0]?.id ?? null);

  const open = (tab: WorkbenchTab) => {
    if (!tabs().some((t) => t.id === tab.id)) {
      setTabs((prev) => [...prev, tab]);
    }
    setActiveId(tab.id);
  };

  const activate = (id: string) => {
    if (tabs().some((t) => t.id === id)) setActiveId(id);
  };

  const close = (id: string) => {
    const index = tabs().findIndex((t) => t.id === id);
    if (index === -1) return;
    const next = tabs().filter((t) => t.id !== id);
    setTabs(next);
    if (activeId() === id) {
      setActiveId(next[Math.min(index, next.length - 1)]?.id ?? null);
    }
  };

  return { tabs, activeId, open, close, activate };
};
