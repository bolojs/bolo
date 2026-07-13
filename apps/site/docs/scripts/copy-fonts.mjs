// docmd has no bundler/npm font pipeline, so the self-hosted Geist woff2 files
// are copied verbatim from the installed fontsource packages into assets/fonts
// (docmd copies project-root ./assets into dist/assets as static files).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const fontsDir = join(projectRoot, 'assets', 'fonts');

mkdirSync(fontsDir, { recursive: true });

const files = [
  ['@fontsource-variable/geist/files/geist-latin-wght-normal.woff2', 'geist-latin-wght-normal.woff2'],
  ['@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2', 'geist-latin-ext-wght-normal.woff2'],
  ['@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2', 'geist-mono-latin-wght-normal.woff2'],
  ['@fontsource-variable/geist-mono/files/geist-mono-latin-ext-wght-normal.woff2', 'geist-mono-latin-ext-wght-normal.woff2'],
];

for (const [pkgPath, destName] of files) {
  const src = new URL(`../node_modules/${pkgPath}`, import.meta.url);
  copyFileSync(fileURLToPath(src), join(fontsDir, destName));
}
