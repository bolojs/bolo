import { ab, captureScreenshot } from './ab';
import { DEMO_URL } from './config';

export const setupBrowser = async (): Promise<void> => {
  ab(`open ${DEMO_URL}`);
  ab('wait --fn "window.__browserbox_ready === true"');
};

export const teardownBrowser = async (extraCleanup?: () => void): Promise<void> => {
  try {
    extraCleanup?.();
    ab('close');
  } catch {
    // Browser may already be closed
  }
};

export { captureScreenshot };

export const withScreenshotOnFailure = async <T>(
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    captureScreenshot(label);
    throw error;
  }
};
