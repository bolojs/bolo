import { describe, it, expect } from 'vitest';
import { createExport } from './export';
import { VfsBus } from '@browser-containers/vfs-bus';
import type { FileSystemTree } from './container-types';

describe('createExport', () => {
  it('returns empty object for empty filesystem', async () => {
    const vfs = new VfsBus();
    const exportTree = createExport(vfs);

    const result = await exportTree();

    expect(result).toEqual({});
  });

  it('exports a single file at root', async () => {
    const vfs = new VfsBus();
    await vfs.writeFile('/index.js', 'console.log("hi")');
    const exportTree = createExport(vfs);

    const result = await exportTree();

    expect(result['index.js']).toEqual({ file: { contents: 'console.log("hi")' } });
  });

  it('exports a single empty directory at root', async () => {
    const vfs = new VfsBus();
    await vfs.mkdir('/src');
    const exportTree = createExport(vfs);

    const result = await exportTree();

    expect(result['src']).toEqual({ directory: {} });
  });

  it('exports nested files in directories', async () => {
    const vfs = new VfsBus();
    await vfs.mkdir('/src');
    await vfs.writeFile('/src/app.ts', 'export const x = 1');
    const exportTree = createExport(vfs);

    const result = await exportTree();

    expect(result['src']).toEqual({
      directory: {
        'app.ts': { file: { contents: 'export const x = 1' } },
      },
    });
  });

  it('exports deeply nested structure', async () => {
    const vfs = new VfsBus();
    await vfs.mkdir('/src', { recursive: true });
    await vfs.mkdir('/src/components', { recursive: true });
    await vfs.mkdir('/src/utils', { recursive: true });
    await vfs.writeFile('/src/components/Button.tsx', 'export const Button = () => null');
    await vfs.writeFile('/src/utils/format.ts', 'export const fmt = (s: string) => s');
    const exportTree = createExport(vfs);

    const result = await exportTree();

    expect(result['src']).toEqual({
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
    });
  });

  it('exports mixed files and directories at same level', async () => {
    const vfs = new VfsBus();
    await vfs.mkdir('/src');
    await vfs.writeFile('/package.json', '{}');
    await vfs.writeFile('/src/index.ts', 'export {}');
    await vfs.writeFile('/readme.md', '# hello');
    const exportTree = createExport(vfs);

    const result = await exportTree();

    expect(result['package.json']).toEqual({ file: { contents: '{}' } });
    expect(result['src']).toEqual({
      directory: {
        'index.ts': { file: { contents: 'export {}' } },
      },
    });
    expect(result['readme.md']).toEqual({ file: { contents: '# hello' } });
  });

  it('exports binary file contents as string via VfsBus readFile', async () => {
    const vfs = new VfsBus();
    await vfs.writeFile('/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const exportTree = createExport(vfs);

    const result = await exportTree();

    const contents = (result['logo.png'] as { file: { contents: string } }).file.contents;
    // VfsBus.readFile returns UTF-8 string from hot layer;
    // \x89 is invalid UTF-8 so it becomes the replacement character
    expect(typeof contents).toBe('string');
    expect(contents).toContain('PNG');
  });

  it('exports directory with multiple files', async () => {
    const vfs = new VfsBus();
    await vfs.mkdir('/src');
    await vfs.writeFile('/src/a.ts', 'a');
    await vfs.writeFile('/src/b.ts', 'b');
    await vfs.writeFile('/src/c.ts', 'c');
    const exportTree = createExport(vfs);

    const result = await exportTree();

    const dir = (result['src'] as { directory: FileSystemTree }).directory;
    expect(Object.keys(dir)).toHaveLength(3);
    expect(dir['a.ts']).toEqual({ file: { contents: 'a' } });
    expect(dir['b.ts']).toEqual({ file: { contents: 'b' } });
    expect(dir['c.ts']).toEqual({ file: { contents: 'c' } });
  });
});
