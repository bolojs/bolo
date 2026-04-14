import { describe, it, expect, vi, beforeEach } from 'vitest';
import { boot } from './boot.js';
import { BrowserContainer } from './container.js';

vi.mock('@browser-containers/sw-sandbox', () => ({
  SWSandbox: {
    create: vi.fn().mockResolvedValue({
      onFetch: vi.fn(),
      setPolicyRegistry: vi.fn(),
    }),
  },
}));

describe('boot()', () => {
  let container: BrowserContainer;

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('returns a BrowserContainer instance', async () => {
    container = await boot();
    expect(container).toBeInstanceOf(BrowserContainer);
    expect(container.fs).toBeDefined();
    expect(container.workdir).toBe('/home/web');
    await container.teardown();
  });

  it('sets workdir from options', async () => {
    container = await boot({ workdirName: '/home/project' });
    expect(container.workdir).toBe('/home/project');
    await container.teardown();
  });

  it('rejects second boot() while active', async () => {
    container = await boot();
    await expect(boot()).rejects.toThrow('already running');
    await container.teardown();
  });

  it('allows re-boot after teardown', async () => {
    const c1 = await boot();
    await c1.teardown();
    const c2 = await boot();
    expect(c2).toBeInstanceOf(BrowserContainer);
    await c2.teardown();
  });

  it('mount and export round-trip', async () => {
    container = await boot();
    const tree = {
      'index.js': { file: { contents: 'console.log(1)' } },
      'src': { directory: { 'app.js': { file: { contents: 'export const app = 1' } } } },
    };
    await container.mount(tree);
    const exported = await container.export();
    expect(exported['index.js']).toEqual(tree['index.js']);
    expect(exported['src']).toEqual(tree['src']);
    await container.teardown();
  });
});
