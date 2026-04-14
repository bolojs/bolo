import { describe, it, expect } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { createFsShim } from '@browser-containers/node-runtime-shims';

describe('Cross-package integration: VfsBus + node-runtime-shims fs shim', () => {
  it('write via fs shim, read via VfsBus directly', async () => {
    const vfs = new VfsBus();
    const fs = createFsShim(vfs);

    // Write via fs shim
    await fs.writeFile('/cross-test.txt', 'fs-shim-data');
    expect(await fs.exists('/cross-test.txt')).toBe(true);

    // Read via VfsBus directly
    const directRead = await vfs.readFile('/cross-test.txt');
    expect(directRead).toBe('fs-shim-data');

    vfs.destroy();
  });
});
