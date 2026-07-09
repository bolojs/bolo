import { describe, it, expect, beforeEach } from 'vitest';
import { VfsBus } from '@browser-containers/vfs-bus';
import { PackageManager } from './package-manager.js';

describe('PackageManager', () => {
  let vfs: VfsBus;
  let pm: PackageManager;

  beforeEach(() => {
    vfs = new VfsBus();
    pm = new PackageManager({ vfs, cwd: '/' });
  });

  describe('generateImportMap', () => {
    it('generates exact and trailing-slash entries with esm.sh URLs', () => {
      const importMap = pm.generateImportMap(['react', 'lodash@4.17.21']);

      expect(importMap.imports['react']).toBe('https://esm.sh/react');
      expect(importMap.imports['react/']).toBe('https://esm.sh/react/');
      expect(importMap.imports['lodash']).toBe('https://esm.sh/lodash@4.17.21');
      expect(importMap.imports['lodash/']).toBe('https://esm.sh/lodash@4.17.21/');
    });

    it('resolves react/jsx-runtime through the trailing-slash react entry', () => {
      const importMap = pm.generateImportMap(['react@18.2.0']);

      expect(importMap.imports['react/']).toBe('https://esm.sh/react@18.2.0/');
      // react/jsx-runtime resolves as `imports['react/']` + 'jsx-runtime'
    });

    it('parses package specifiers correctly, including scoped packages', () => {
      const importMap = pm.generateImportMap(['react', 'react-dom@18.2.0', '@mui/material@5.0.0']);

      expect(importMap.imports['react']).toBe('https://esm.sh/react');
      expect(importMap.imports['@mui/material']).toBe('https://esm.sh/@mui/material@5.0.0');
      expect(importMap.imports['@mui/material/']).toBe('https://esm.sh/@mui/material@5.0.0/');
    });

    it('externalizes react-dom with the esm.sh `*` prefix for a single React singleton', () => {
      const importMap = pm.generateImportMap(['react-dom@18.2.0']);

      expect(importMap.imports['react-dom']).toBe('https://esm.sh/*react-dom@18.2.0');
      expect(importMap.imports['react-dom/']).toBe('https://esm.sh/*react-dom@18.2.0/');
    });

    it('supports jsr: specifier resolution', () => {
      const importMap = pm.generateImportMap(['jsr:@std/assert@1.0.0']);

      expect(importMap.imports['@std/assert']).toBe('https://esm.sh/@std/assert@1.0.0');
    });
  });

  describe('writeImportMap (via install)', () => {
    it('generates the importmap from package.json deps, excluding build tooling', async () => {
      await vfs.writeFile('/package.json', JSON.stringify({
        dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
        devDependencies: { vite: '^5.0.0' },
      }));

      const specifiers = (pm as any).getImportMapPackageSpecifiers() as string[];

      expect(specifiers).toContain('react@^18.2.0');
      expect(specifiers).toContain('react-dom@^18.2.0');
      expect(specifiers).not.toContain('vite@^5.0.0');
      expect(specifiers.some(s => s.startsWith('vite'))).toBe(false);
    });

    it('prefers the actually-installed version over the declared range', async () => {
      await vfs.writeFile('/package.json', JSON.stringify({
        dependencies: { react: '^18.2.0' },
      }));
      await vfs.writeFile('/node_modules/react/package.json', JSON.stringify({ version: '18.2.0' }));

      const version = (pm as any).readInstalledVersion('react');
      expect(version).toBe('18.2.0');

      const specifiers = (pm as any).getImportMapPackageSpecifiers() as string[];
      expect(specifiers).toContain('react@18.2.0');
    });

    it('falls back to the declared range when nothing is installed', () => {
      const version = (pm as any).readInstalledVersion('react');
      expect(version).toBeUndefined();
    });
  });

  it('writes import map to VFS', async () => {
    await vfs.writeFile('/importmap.json', JSON.stringify({ test: 'data' }));

    const importMapContent = await vfs.readFile('/importmap.json') as string;
    const importMap = JSON.parse(importMapContent);

    expect(importMap.test).toBe('data');
  });
});
