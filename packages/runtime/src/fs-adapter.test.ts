import { describe, it, expect } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { createFileSystem } from './fs-adapter';
import type { DirEnt } from './container-types';

describe('createFileSystem with real VfsBus', () => {
  describe('readFile', () => {
    it('reads a text file and returns string', async () => {
      const vfs = new VfsBus();
      await vfs.writeFile('/test.txt', 'hello world');
      const fs = createFileSystem(vfs);

      const content = await fs.readFile('/test.txt');
      expect(content).toBe('hello world');
    });

    it('reads binary file and decodes to string', async () => {
      const vfs = new VfsBus();
      const binaryData = new Uint8Array([72, 101, 108, 108, 111]);
      await vfs.writeFile('/test.bin', binaryData);
      const fs = createFileSystem(vfs);

      const content = await fs.readFile('/test.bin');
      expect(content).toBe('Hello');
    });

    it('throws ENOENT when file does not exist', async () => {
      const vfs = new VfsBus();
      const fs = createFileSystem(vfs);

      const error = await fs.readFile('/nonexistent.txt').catch(e => e);
      expect(error).toHaveProperty('code', 'ENOENT');
    });
  });

  describe('writeFile', () => {
    it('writes string content to a file', async () => {
      const vfs = new VfsBus();
      const fs = createFileSystem(vfs);

      await fs.writeFile('/test.txt', 'hello world');
      const content = await vfs.readFile('/test.txt');
      expect(content).toBe('hello world');
    });

    it('writes Uint8Array content to a file', async () => {
      const vfs = new VfsBus();
      const fs = createFileSystem(vfs);

      const data = new Uint8Array([72, 101, 108, 108, 111]);
      await fs.writeFile('/test.bin', data);
      const content = await fs.readFile('/test.bin');
      expect(content).toBe('Hello');
    });
  });

  describe('mkdir', () => {
    it('creates a directory', async () => {
      const vfs = new VfsBus();
      const fs = createFileSystem(vfs);

      await fs.mkdir('/newdir');
      const exists = await vfs.exists('/newdir');
      expect(exists).toBe(true);
    });

    it('creates nested directories with recursive option', async () => {
      const vfs = new VfsBus();
      const fs = createFileSystem(vfs);

      await fs.mkdir('/a/b/c', { recursive: true });
      const exists = await vfs.exists('/a/b/c');
      expect(exists).toBe(true);
    });
  });

  describe('rm', () => {
    it('removes a file', async () => {
      const vfs = new VfsBus();
      await vfs.writeFile('/test.txt', 'hello');
      const fs = createFileSystem(vfs);

      await fs.rm('/test.txt');
      const exists = await vfs.exists('/test.txt');
      expect(exists).toBe(false);
    });

    it('removes a directory', async () => {
      const vfs = new VfsBus();
      await vfs.mkdir('/testdir');
      const fs = createFileSystem(vfs);

      await fs.rm('/testdir');
      const exists = await vfs.exists('/testdir');
      expect(exists).toBe(false);
    });
  });

  describe('readdir', () => {
    it('returns array of strings by default', async () => {
      const vfs = new VfsBus();
      await vfs.writeFile('/a.txt', 'a');
      await vfs.writeFile('/b.txt', 'b');
      await vfs.mkdir('/cdir');
      const fs = createFileSystem(vfs);

      const entries = await fs.readdir('/');
      expect(entries).toContain('a.txt');
      expect(entries).toContain('b.txt');
      expect(entries).toContain('cdir');
    });

    it('returns DirEnt array when withFileTypes is true', async () => {
      const vfs = new VfsBus();
      await vfs.writeFile('/file.txt', 'content');
      await vfs.mkdir('/directory');
      const fs = createFileSystem(vfs);

      const entries = await fs.readdir('/', { withFileTypes: true }) as DirEnt[];
      expect(entries).toBeInstanceOf(Array);
      expect(entries.length).toBeGreaterThanOrEqual(2);

      const file = entries.find((e) => e.name === 'file.txt');
      const dir = entries.find((e) => e.name === 'directory');

      expect(file).toBeTruthy();
      expect(dir).toBeTruthy();
      expect(file?.isFile()).toBe(true);
      expect(file?.isDirectory()).toBe(false);
      expect(dir?.isFile()).toBe(false);
      expect(dir?.isDirectory()).toBe(true);
    });

    it('throws ENOENT when directory does not exist', async () => {
      const vfs = new VfsBus();
      const fs = createFileSystem(vfs);

      const error = await fs.readdir('/nonexistent').catch(e => e);
      expect(error).toHaveProperty('code', 'ENOENT');
    });
  });

  describe('rename', () => {
    it('renames a file', async () => {
      const vfs = new VfsBus();
      await vfs.writeFile('/old.txt', 'content');
      const fs = createFileSystem(vfs);

      await fs.rename('/old.txt', '/new.txt');
      const existsOld = await vfs.exists('/old.txt');
      const existsNew = await vfs.exists('/new.txt');
      const content = await vfs.readFile('/new.txt');

      expect(existsOld).toBe(false);
      expect(existsNew).toBe(true);
      expect(content).toBe('content');
    });

    it('throws ENOENT when source does not exist', async () => {
      const vfs = new VfsBus();
      const fs = createFileSystem(vfs);

      const error = await fs.rename('/nonexistent', '/target').catch(e => e);
      expect(error).toHaveProperty('code', 'ENOENT');
    });

    it('throws EEXIST when target already exists', async () => {
      const vfs = new VfsBus();
      await vfs.writeFile('/source.txt', 'src');
      await vfs.writeFile('/target.txt', 'tgt');
      const fs = createFileSystem(vfs);

      const error = await fs.rename('/source.txt', '/target.txt').catch(e => e);
      expect(error).toHaveProperty('code', 'EEXIST');
    });

    it('moves file across directories', async () => {
      const vfs = new VfsBus();
      await vfs.mkdir('/dir1');
      await vfs.mkdir('/dir2');
      await vfs.writeFile('/dir1/file.txt', 'content');
      const fs = createFileSystem(vfs);

      await fs.rename('/dir1/file.txt', '/dir2/file.txt');
      const existsOld = await vfs.exists('/dir1/file.txt');
      const existsNew = await vfs.exists('/dir2/file.txt');

      expect(existsOld).toBe(false);
      expect(existsNew).toBe(true);
    });
  });
});
