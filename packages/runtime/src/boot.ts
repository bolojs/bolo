import type { BootOptions } from "./container-types.js";
import { BrowserContainer } from "./container.js";
import { RuntimeBuilder } from "./runtime-builder.js";

let activeInstance: BrowserContainer | null = null;
let bootPromise: Promise<BrowserContainer> | null = null;

export const boot = async (options?: BootOptions): Promise<BrowserContainer> => {
  if (bootPromise) {
    return bootPromise;
  }

  if (activeInstance) {
    throw new Error("A browser container is already running");
  }

  bootPromise = (async () => {
    const container = await new RuntimeBuilder(options ?? {}).build();
    const builderTeardown = container.teardown.bind(container);
    container.teardown = async () => {
      await builderTeardown();
      activeInstance = null;
      bootPromise = null;
    };
    activeInstance = container;
    return container;
  })();

  try {
    const container = await bootPromise;
    bootPromise = null;
    return container;
  } catch (err) {
    bootPromise = null;
    throw err;
  }
};
