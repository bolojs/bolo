import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { VfsBus } from '@bolojs/vfs-bus';
import { createWasiTool } from '../src/wasi-executor.js';
import { registerWasmTool, resolveWasmTool, createWasmRegistry, clearCache } from '../src/registry.js';

const fixturePath = fileURLToPath(new URL('./fixtures/wasi-echo/echo.wasm', import.meta.url));
const wasmBytes = readFileSync(fixturePath);

describe('wasm-registry: generic WASI executor', () => {
  let vfs: VfsBus;

  beforeEach(() => {
    vfs = new VfsBus();
    clearCache();
  });

  it('runs a real wasm32-wasip1 binary registered via registerWasmTool()', async () => {
    await vfs.mkdir('/work', { recursive: true });
    await vfs.writeFile('/work/input.txt', 'hello wasi');

    registerWasmTool('wasi-echo', async () =>
      createWasiTool(async () => wasmBytes, { vfs, preopens: [{ guestPath: '/work' }] }, 'wasi-echo'),
    );

    const tool = await resolveWasmTool('wasi-echo');
    expect(tool).toBeDefined();

    const result = await tool!.run(['foo', 'bar']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('argc=3');
    expect(result.stdout).toContain('arg[1]=foo');
    expect(result.stdout).toContain('arg[2]=bar');
    expect(result.stdout).toContain('read:hello wasi');
    expect(result.stderr).toBe('');
  });

  it('writes made by the WASI module are flushed back to VfsBus', async () => {
    await vfs.mkdir('/work', { recursive: true });
    await vfs.writeFile('/work/input.txt', 'round trip');

    const tool = createWasiTool(async () => wasmBytes, { vfs, preopens: [{ guestPath: '/work' }] }, 'wasi-echo');
    const result = await tool.run([]);

    expect(result.exitCode).toBe(0);
    expect(await vfs.exists('/work/output.txt')).toBe(true);
    expect(String(await vfs.readFile('/work/output.txt'))).toBe('processed:round trip');
  });

  it('returns a non-zero exit code and stderr when the preopen is missing the expected file', async () => {
    await vfs.mkdir('/work', { recursive: true });

    const tool = createWasiTool(async () => wasmBytes, { vfs, preopens: [{ guestPath: '/work' }] }, 'wasi-echo');
    const result = await tool.run([]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('could not open input');
  });

  it('dispatches through createWasmRegistry() like the other WASM tools', async () => {
    await vfs.mkdir('/work', { recursive: true });
    await vfs.writeFile('/work/input.txt', 'via registry');

    registerWasmTool('wasi-echo', async () =>
      createWasiTool(async () => wasmBytes, { vfs, preopens: [{ guestPath: '/work' }] }, 'wasi-echo'),
    );

    const registry = createWasmRegistry();
    const result = await registry.dispatch('wasi-echo', []);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('read:via registry');
  });
});
