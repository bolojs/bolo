// Playwright launch helpers shared by the spike runners.
import { chromium, firefox, webkit, type Browser, type Page } from "playwright-core";

export type EngineName = "chromium" | "firefox" | "webkit";

export const engines: EngineName[] = ["chromium", "firefox", "webkit"];

const launchers = { chromium, firefox, webkit };

export const launchEngine = async (
  name: EngineName,
  opts: { headless?: boolean; args?: string[] } = {},
): Promise<Browser> => {
  const headless = opts.headless ?? true;
  if (name === "chromium") {
    return chromium.launch({
      headless,
      // CHROME env override (repo convention); otherwise playwright-core's
      // own cached headless shell.
      executablePath: process.env.CHROME || undefined,
      args: opts.args,
    });
  }
  return launchers[name].launch({ headless, args: opts.args });
};

// Install observability taps before any navigation: page console, pageerror,
// requestfailed, dedicated-worker and service-worker lifecycle.
export const observePage = (page: Page, tag: string) => {
  page.on("console", (msg) => console.log(`[${tag}:console:${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[${tag}:pageerror] ${err.message}`));
  page.on("requestfailed", (req) =>
    console.log(`[${tag}:requestfailed] ${req.url()} ${req.failure()?.errorText}`),
  );
  page.on("workercreated", (w) => console.log(`[${tag}:workercreated] ${w.url()}`));
  page.on("workerdestroyed", (w) => console.log(`[${tag}:workerdestroyed] ${w.url()}`));
  page.context().on("serviceworker", (w) => console.log(`[${tag}:serviceworker] ${w.url()}`));
};

export const engineVersion = async (browser: Browser): Promise<string> => browser.version();
