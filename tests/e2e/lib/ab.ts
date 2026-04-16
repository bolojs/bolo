import { execSync } from 'child_process';

export const ab = (cmd: string): string => {
  try {
    return execSync(`agent-browser ${cmd}`, { encoding: 'utf8' });
  } catch (error) {
    const err = error as { message?: string; stderr?: Buffer };
    const stderr = err.stderr?.toString() || err.message || 'Unknown error';
    throw new Error(`agent-browser command failed: ${stderr}`);
  }
};

export const captureScreenshot = (label = 'failure'): void => {
  const timestamp = Date.now();
  const filename = `tests/e2e/screenshots/failure-${label}-${timestamp}.png`;
  try {
    execSync(`agent-browser screenshot ${filename}`, { encoding: 'utf8' });
    console.log(`Screenshot saved: ${filename}`);
  } catch {
    console.log('Failed to capture screenshot');
  }
};
