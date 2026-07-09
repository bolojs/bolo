import { describe, it, expect } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { createFsShim } from './fs-shim.js';
import type fs from 'node:fs';

describe('fs shim', () => {
  it('write-read round-trip via VfsBus', async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);
    const _typeCheck: typeof fs = shim as unknown as typeof fs;
    void _typeCheck;

    await shim.writeFile('/test.txt', 'hello');
    const data = await shim.readFile('/test.txt', 'utf8');
    expect(data).toBe('hello');
  });

  it('mkdir creates directories', async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.mkdir('/nested/dir', { recursive: true });
    expect(await shim.exists('/nested/dir')).toBe(true);
    expect(await shim.readdir('/nested')).toContain('dir');
  });

  it('rm removes files', async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.writeFile('/delete-me.txt', 'bye');
    await shim.rm('/delete-me.txt');
    expect(await shim.exists('/delete-me.txt')).toBe(false);
  });

  it('sync methods are backed for real by the synchronous memfs volume (vfs.hot)', () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.mkdirSync('/nested/dir', { recursive: true });
    expect(shim.existsSync('/nested/dir')).toBe(true);
    expect(shim.readdirSync('/nested')).toContain('dir');

    shim.writeFileSync('/x.txt', 'sync hello');
    expect(shim.readFileSync('/x.txt', 'utf8')).toBe('sync hello');

    const s = shim.statSync('/x.txt');
    expect(s.isFile()).toBe(true);
    expect(s.isDirectory()).toBe(false);
    expect(s.size).toBe('sync hello'.length);

    shim.rmSync('/x.txt');
    expect(shim.existsSync('/x.txt')).toBe(false);
  });

  it('readFileSync returns raw bytes when no encoding is given', () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    shim.writeFileSync('/bin.dat', 'abc');
    const raw = shim.readFileSync('/bin.dat');
    expect(raw).toBeInstanceOf(Uint8Array);
  });

  it('stat returns file metadata', async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.writeFile('/stats.txt', 'content');
    const s = await shim.stat('/stats.txt');
    expect(s.isFile()).toBe(true);
    expect(s.isDirectory()).toBe(false);
    expect(s.size).toBe(7);
  });

  it('promises namespace has all async methods', async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);

    await shim.promises.writeFile('/p.txt', 'data');
    expect(await shim.promises.readFile('/p.txt', 'utf8')).toBe('data');
    expect(await shim.promises.exists('/p.txt')).toBe(true);
  });
});
