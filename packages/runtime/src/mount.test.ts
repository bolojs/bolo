import { describe, it, expect } from 'vitest';
import { createMount } from './mount';
import { VfsBus } from '@browser-containers/vfs-bus';
import type { FileSystemTree } from './container-types';

describe('createMount', () => {
  it('mounts a single file at root', async () => {
    const vfs = new VfsBus();
    const mount = createMount(vfs);

    const tree: FileSystemTree = {
      'index.js': { file: { contents: 'console.log("hi")' } },
    };

    await mount(tree);

    const result = await vfs.readFile('/index.js');
    expect(result).toBe('console.log("hi")');
  });

  it('mounts a single directory at root', async () => {
    const vfs = new VfsBus();
    const mount = createMount(vfs);

    const tree: FileSystemTree = {
      src: { directory: {} },
    };

    await mount(tree);

    expect(await vfs.exists('/src')).toBe(true);
  });

  it('mounts nested files in directories', async () => {
    const vfs = new VfsBus();
    const mount = createMount(vfs);

    const tree: FileSystemTree = {
      src: {
        directory: {
          'app.ts': { file: { contents: 'export const x = 1' } },
        },
      },
    };

    await mount(tree);

    const result = await vfs.readFile('/src/app.ts');
    expect(result).toBe('export const x = 1');
  });

  it('mounts deeply nested structure', async () => {
    const vfs = new VfsBus();
    const mount = createMount(vfs);

    const tree: FileSystemTree = {
      src: {
        directory: {
          components: {
            directory: {
              'Button.tsx': { file: { contents: 'export const Button = () => null' } },
            },
          },
          utils: {
            directory: {
              'format.ts': { file: { contents: 'export const fmt = (s: string) => s' } },
            },
          },
        },
      },
    };

    await mount(tree);

    expect(await vfs.readFile('/src/components/Button.tsx')).toBe('export const Button = () => null');
    expect(await vfs.readFile('/src/utils/format.ts')).toBe('export const fmt = (s: string) => s');
  });

  it('mounts files with Uint8Array contents', async () => {
    const vfs = new VfsBus();
    const mount = createMount(vfs);

    const tree: FileSystemTree = {
      'logo.png': { file: { contents: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } },
    };

    await mount(tree);

    expect(await vfs.exists('/logo.png')).toBe(true);
  });

  it('mounts empty tree without error', async () => {
    const vfs = new VfsBus();
    const mount = createMount(vfs);

    await mount({});
  });

  it('mounts mixed files and directories at same level', async () => {
    const vfs = new VfsBus();
    const mount = createMount(vfs);

    const tree: FileSystemTree = {
      'package.json': { file: { contents: '{}' } },
      src: {
        directory: {
          'index.ts': { file: { contents: 'export {}' } },
        },
      },
      'readme.md': { file: { contents: '# hello' } },
    };

    await mount(tree);

    expect(await vfs.readFile('/package.json')).toBe('{}');
    expect(await vfs.readFile('/src/index.ts')).toBe('export {}');
    expect(await vfs.readFile('/readme.md')).toBe('# hello');
  });
});
