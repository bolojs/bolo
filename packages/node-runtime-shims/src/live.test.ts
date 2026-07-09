import { describe, it, expect } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { createLiveShimRegistry } from './live.js';

describe('createLiveShimRegistry', () => {
  it('includes stateless node-web-shims builtins and a vfs-bound fs shim', () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });

    expect(registry.path).toBeDefined();
    expect(registry.buffer).toBeDefined();
    expect(typeof (registry.fs as { readFile: unknown }).readFile).toBe('function');
    expect(registry.http).toBeUndefined();
    expect(registry.net).toBeUndefined();
  });

  it('binds http/net to the sandbox when one is provided', () => {
    const vfs = new VfsBus();
    const sandbox = { onFetch: () => {} } as unknown as Parameters<typeof createLiveShimRegistry>[0]['sandbox'];
    const registry = createLiveShimRegistry({ vfs, sandbox });

    expect(registry.http).toBeDefined();
    expect(registry.http).toBe(registry.net);
  });
});
