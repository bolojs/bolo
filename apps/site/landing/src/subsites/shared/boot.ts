import { boot, type BootOptions, type BrowserContainer } from "@bolojs/runtime";
import type { VfsBus } from "@bolojs/fs";

/**
 * The VfsBus of the booted container. boot() is a page-global singleton, so
 * this is well-defined after bootSubsite() resolves. Uses the same
 * globalThis.__vfsBus bridge the runtime installs (and the e2e bridge reads).
 */
export const getBootedVfs = (): VfsBus => {
  const vfs = (globalThis as unknown as { __vfsBus?: VfsBus }).__vfsBus;
  if (!vfs) throw new Error("No booted container VFS on globalThis.__vfsBus");
  return vfs;
};

export interface SubsiteBootOptions {
  /** Extra boot options merged over the subsite defaults. */
  boot?: Omit<BootOptions, "swPath">;
}

/**
 * Boot the page-global container for a catalog subsite. Each subsite page
 * owns exactly one container lifetime (boot() is a process-global
 * singleton), and the service worker is scoped to the subsite directory
 * ("/ide/sw.js" -> scope "/ide/") so it coexists with the root SW.
 */
export const bootSubsite = async (
  subsite: string,
  options: SubsiteBootOptions = {},
): Promise<BrowserContainer> => {
  const container = await boot({
    workdirName: "/home/web",
    swPath: `/${subsite}/sw.js`,
    ...options.boot,
  });
  installPagehideTeardown(container);
  return container;
};

/**
 * Teardown is async but pagehide gives no completion guarantee: start it and
 * let the browser tear down the page around it. Reloading or navigating away
 * from a subsite must not leak the singleton for the next page load.
 */
const installPagehideTeardown = (container: BrowserContainer): void => {
  if (typeof window === "undefined") return;
  window.addEventListener("pagehide", () => {
    void container.teardown().catch(() => {
      // The page is going away; nothing useful to do with a failed teardown.
    });
  });
};
