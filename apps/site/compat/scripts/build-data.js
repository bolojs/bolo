import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, '..', '..', 'landing', 'public', 'results');
const outDir = join(dirname(__dirname), 'src', 'data');
const outFile = join(outDir, 'packages.json');
const latestFile = join(outDir, 'latest.json');
const historyFile = join(outDir, 'history.json');

const nodeCompat = JSON.parse(readFileSync(join(sourceDir, 'node-compat.json'), 'utf8'));
const packageMatrix = JSON.parse(readFileSync(join(sourceDir, 'package-matrix.json'), 'utf8'));
const tools = JSON.parse(readFileSync(join(sourceDir, 'tools.json'), 'utf8'));

const nodeMap = new Map(nodeCompat.modules.map((m) => [m.name, m]));
const pkgMap = new Map(packageMatrix.packages.map((p) => [p.name, p]));
const toolMap = new Map(tools.map((t) => [t.name, t]));

const columns = [
  { key: 'node24', label: 'Node 24 Krypton', measured: false },
  { key: 'node22', label: 'Node 22 Jod', measured: false },
  { key: 'deno', label: 'Deno 2', measured: false },
  { key: 'bun', label: 'Bun 1.x', measured: false },
  { key: 'browser', label: 'Browser (latest)', measured: true },
  { key: 'safari', label: 'Safari (latest)', measured: false },
];

const categories = [
  { key: 'http-clients', label: 'HTTP clients' },
  { key: 'file-system', label: 'File system' },
  { key: 'build-tools', label: 'Build tools' },
  { key: 'bundlers', label: 'Bundlers' },
  { key: 'testing', label: 'Testing' },
  { key: 'http-servers', label: 'HTTP servers' },
  { key: 'crypto', label: 'Crypto' },
  { key: 'templates', label: 'Templates' },
  { key: 'node-core', label: 'Node core APIs' },
];

const rowsSpec = [
  { name: 'fetch', category: 'http-clients' },
  { name: 'axios', category: 'http-clients' },
  { name: 'node-fetch', category: 'http-clients' },
  { name: 'undici', category: 'http-clients' },
  { name: 'fs-extra', category: 'file-system' },
  { name: 'globby', category: 'file-system' },
  { name: 'chokidar', category: 'file-system' },
  { name: 'esbuild', category: 'build-tools' },
  { name: 'swc', category: 'build-tools' },
  { name: 'tsc', category: 'build-tools' },
  { name: 'sass', category: 'build-tools' },
  { name: 'rollup', category: 'bundlers' },
  { name: 'webpack', category: 'bundlers' },
  { name: 'vite', category: 'bundlers' },
  { name: 'parcel', category: 'bundlers' },
  { name: 'vitest', category: 'testing' },
  { name: 'jest', category: 'testing' },
  { name: 'express', category: 'http-servers' },
  { name: 'fastify', category: 'http-servers' },
  { name: 'h3', category: 'http-servers' },
  { name: 'polka', category: 'http-servers' },
  { name: 'crypto-js', category: 'crypto' },
  { name: 'bcrypt', category: 'crypto' },
  { name: 'argon2', category: 'crypto' },
  { name: 'handlebars', category: 'templates' },
  { name: 'ejs', category: 'templates' },
  { name: 'pug', category: 'templates' },
  { name: 'events', category: 'node-core' },
  { name: 'stream', category: 'node-core' },
  { name: 'buffer', category: 'node-core' },
  { name: 'crypto', category: 'node-core' },
  { name: 'path', category: 'node-core' },
  { name: 'url', category: 'node-core' },
  { name: 'querystring', category: 'node-core' },
  { name: 'zlib', category: 'node-core' },
  { name: 'os', category: 'node-core' },
  { name: 'util', category: 'node-core' },
  { name: 'assert', category: 'node-core' },
  { name: 'fs', category: 'node-core' },
  { name: 'http', category: 'node-core' },
];

function cellFromStatus(status, source) {
  switch (status) {
    case 'pass':
      return { status: 'pass', note: source === 'tool' ? 'Browser ready' : 'Supported' };
    case 'partial':
      return { status: 'partial', note: source === 'tool' ? 'Limited browser support' : 'Partial support' };
    case 'fail':
      return { status: 'fail', note: source === 'tool' ? 'Not browser ready' : 'Not supported' };
    default:
      return { status: 'unknown', note: 'No data' };
  }
}

function coreStatus(module) {
  if (module.passed === module.total) return 'pass';
  if (module.passed === 0) return 'fail';
  return 'partial';
}

function toolStatus(tool) {
  if (tool.status === 'stable') return 'pass';
  if (tool.status === 'beta' || tool.status === 'wip') return 'partial';
  if (tool.status === 'none') return 'fail';
  return 'unknown';
}

function packageStatus(pkg) {
  if (pkg.status === 'pass') return 'pass';
  if (pkg.status === 'fail') return 'fail';
  return 'unknown';
}

function makeCells(status, source) {
  const cells = {};
  for (const col of columns) {
    if (col.key === 'browser') {
      cells[col.key] = cellFromStatus(status, source);
    } else {
      cells[col.key] = { status: 'unknown', note: 'Not measured' };
    }
  }
  return cells;
}

function makeDetails(row) {
  const details = { features: [], knownIssues: [], links: [], raw: '' };
  const tool = toolMap.get(row.name);
  const pkg = pkgMap.get(row.name);
  const mod = nodeMap.get(row.name);

  if (tool) {
    if (tool.wasmPackage) details.features.push(`WASM package: ${tool.wasmPackage}`);
    if (tool.wasmTarget) details.features.push(`WASM target: ${tool.wasmTarget}`);
    details.features.push(`Browser ready: ${tool.browserReady}`);
    if (tool.requiresSimd) details.features.push('Requires SIMD');
    if (tool.requiresThreads) details.features.push('Requires threads');
    details.knownIssues.push(tool.notes);
    details.links.push(`https://www.npmjs.com/package/${tool.npm}`);
    details.raw = JSON.stringify(tool, null, 2);
  } else if (pkg) {
    details.features.push(`Class: ${pkg.class}`);
    if (pkg.error) details.knownIssues.push(pkg.error);
    details.links.push(`https://www.npmjs.com/package/${pkg.name}`);
    details.raw = JSON.stringify(pkg, null, 2);
  } else if (mod) {
    details.features.push(`${mod.passed}/${mod.total} tests passed`);
    details.knownIssues.push(
      ...mod.tests.filter((t) => t.status !== 'pass').map((t) => `${t.file}: ${t.error}`)
    );
    if (details.knownIssues.length === 0) details.knownIssues = ['No known issues'];
    details.raw = JSON.stringify(mod.tests, null, 2);
  }

  return details;
}

function makeRow(spec) {
  const tool = toolMap.get(spec.name);
  const pkg = pkgMap.get(spec.name);
  const mod = nodeMap.get(spec.name);

  let status = 'unknown';
  let source = 'unknown';
  let wasmOnly = false;

  if (tool) {
    status = toolStatus(tool);
    source = 'tool';
    wasmOnly = Boolean(tool.wasmPackage);
  } else if (pkg) {
    status = packageStatus(pkg);
    source = 'package';
  } else if (mod) {
    status = coreStatus(mod);
    source = 'core';
  }

  const categoryLabel = categories.find((c) => c.key === spec.category)?.label ?? spec.category;

  return {
    id: spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: spec.name,
    category: spec.category,
    categoryLabel,
    description: '',
    wasmOnly,
    cells: makeCells(status, source),
    details: makeDetails(spec),
  };
}

const rows = rowsSpec.map(makeRow);

const output = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: 'apps/site/landing/public/results',
  },
  columns,
  categories,
  rows,
};

const STUB_RUN_URL =
  'https://github.com/browser-containers/browser-containers/actions/workflows/compat-harness.yml';

function resolveRunUrl(id) {
  const argIdx = process.argv.indexOf('--run-url');
  const argUrl = argIdx >= 0 ? process.argv[argIdx + 1] : undefined;
  if (argUrl) return argUrl;
  if (process.env.RUN_URL) return process.env.RUN_URL;
  const entries = history[id] ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const link = entries[i]?.link;
    if (link) return link;
  }
  return STUB_RUN_URL;
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

const today = new Date().toISOString().slice(0, 10);
const history = existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, 'utf8')) : {};
const latest = {};

for (const row of rows) {
  const status = row.cells.browser.status;
  const link = resolveRunUrl(row.id);
  latest[row.id] = { status, date: today, link };

  const arr = history[row.id] ?? [];
  const idx = arr.findIndex((e) => e.date === today);
  const entry = { date: today, status, link };
  if (idx >= 0) arr[idx] = entry;
  else arr.push(entry);
  history[row.id] = arr.sort((a, b) => a.date.localeCompare(b.date));
}

mkdirSync(outDir, { recursive: true });
writeJsonAtomic(outFile, output);
writeJsonAtomic(latestFile, latest);
writeJsonAtomic(historyFile, history);
console.log(`Wrote ${outFile}`);
console.log(`Wrote ${latestFile}`);
console.log(`Wrote ${historyFile}`);
