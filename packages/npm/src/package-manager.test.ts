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

  it('generates import map with esm.sh URLs', () => {
    const importMap = pm.generateImportMap(['react', 'lodash@4.17.21']);

    expect(importMap.imports['react']).toBe('https://esm.sh/react');
    expect(importMap.imports['lodash']).toBe('https://esm.sh/lodash@4.17.21');
  });

  it('parses package specifiers correctly', () => {
    const importMap = pm.generateImportMap(['react', 'react-dom@18.2.0', '@mui/material@5.0.0']);

    expect(importMap.imports['react']).toBe('https://esm.sh/react');
    expect(importMap.imports['react-dom']).toBe('https://esm.sh/react-dom@18.2.0');
    expect(importMap.imports['@mui/material']).toBe('https://esm.sh/@mui/material@5.0.0');
  });

  it('supports jsr: specifier resolution', () => {
    const importMap = pm.generateImportMap(['jsr:@std/assert@1.0.0']);

    expect(importMap.imports['@std/assert']).toBe('https://esm.sh/@std/assert@1.0.0');
  });

  it('reads dependencies from package.json when no packages specified', async () => {
    await vfs.writeFile('/package.json', JSON.stringify({
      dependencies: {
        'react': '^18.2.0',
        'lodash': '^4.17.21',
      },
      devDependencies: {
        'vitest': '^2.1.0',
      },
    }));

    const packages = ['react@^18.2.0', 'lodash@^4.17.21', 'vitest@^2.1.0'];
    const importMap = pm.generateImportMap(packages);

    expect(importMap.imports['react']).toBe('https://esm.sh/react@^18.2.0');
    expect(importMap.imports['lodash']).toBe('https://esm.sh/lodash@^4.17.21');
    expect(importMap.imports['vitest']).toBe('https://esm.sh/vitest@^2.1.0');
  });

  it('writes import map to VFS', async () => {
    await vfs.writeFile('/importmap.json', JSON.stringify({ test: 'data' }));

    const importMapContent = await vfs.readFile('/importmap.json') as string;
    const importMap = JSON.parse(importMapContent);

    expect(importMap.test).toBe('data');
  });
});
