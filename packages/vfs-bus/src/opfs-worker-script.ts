export const opfsWorkerScript = `
function ensureDir(dirHandle, path) {
  if (!path) return Promise.resolve(dirHandle);
  const [head, ...rest] = path.split('/').filter(Boolean);
  if (!head) return Promise.resolve(dirHandle);
  return dirHandle.getDirectoryHandle(head, { create: true }).then(h => ensureDir(h, rest.join('/')));
}

async function opfsGetRoot() {
  return navigator.storage.getDirectory();
}

const IDB_NAME = 'vfs-bus-opfs-fallback';
const IDB_STORE = 'files';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTx(mode) {
  return idbOpen().then(db => {
    const tx = db.transaction(IDB_STORE, mode);
    const store = tx.objectStore(IDB_STORE);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return { store, done };
  });
}

async function idbRead(path) {
  const { store, done } = await idbTx('readonly');
  const req = store.get(path);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => { void done.then(() => resolve(req.result)); };
    req.onerror = () => reject(req.error);
  });
}

async function idbWrite(path, content) {
  const { store, done } = await idbTx('readwrite');
  store.put(content, path);
  await done;
}

async function idbDelete(path) {
  const { store, done } = await idbTx('readwrite');
  store.delete(path);
  await done;
}

async function idbExists(path) {
  const { store, done } = await idbTx('readonly');
  const req = store.count(path);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => { void done.then(() => resolve(req.result > 0)); };
    req.onerror = () => reject(req.error);
  });
}

async function idbKeys(prefix) {
  const { store, done } = await idbTx('readonly');
  const req = store.getAllKeys();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      void done.then(() => {
        const keys = req.result.filter(k => k.startsWith(prefix));
        const entries = keys.map(k => k.slice(prefix.length).split('/')[0]);
        resolve([...new Set(entries)]);
      });
    };
    req.onerror = () => reject(req.error);
  });
}

async function opfsRead(path) {
  const root = await opfsGetRoot();
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  const dirHandle = parts.length > 0 ? await ensureDir(root, parts.join('/')) : root;
  const fileHandle = await dirHandle.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function opfsWrite(path, content) {
  const root = await opfsGetRoot();
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  const dirHandle = parts.length > 0 ? await ensureDir(root, parts.join('/')) : root;
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const accessHandle = await fileHandle.createSyncAccessHandle();
  accessHandle.write(content);
  accessHandle.flush();
  accessHandle.close();
}

async function opfsRm(path) {
  const root = await opfsGetRoot();
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  const dirHandle = parts.length > 0 ? await ensureDir(root, parts.join('/')) : root;
  await dirHandle.removeEntry(name, { recursive: true });
}

async function opfsExists(path) {
  try {
    const root = await opfsGetRoot();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    const dirHandle = parts.length > 0 ? await ensureDir(root, parts.join('/')) : root;
    await dirHandle.getDirectoryHandle(name);
    return true;
  } catch {
    try {
      const root = await opfsGetRoot();
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      const dirHandle = parts.length > 0 ? await ensureDir(root, parts.join('/')) : root;
      await dirHandle.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}

async function opfsReaddir(path) {
  const root = await opfsGetRoot();
  const dirHandle = path ? await ensureDir(root, path) : root;
  const entries = [];
  for await (const [name] of dirHandle.entries()) {
    entries.push(name);
  }
  return entries;
}

let backend = 'opfs';

async function detectBackend() {
  if (typeof navigator?.storage?.getDirectory === 'function') {
    try {
      await navigator.storage.getDirectory();
      return 'opfs';
    } catch {
      return 'idb';
    }
  }
  return 'idb';
}

// Content-addressed storage: blobs are stored once per unique sha256 hash,
// with a path -> hash manifest and per-hash refcounts so a blob is only
// dropped once nothing references it. This mirrors the pure algorithm in
// ../src/cas.ts (unit tested there) — this classic Blob-worker script can't
// import that module, so keep the two in sync when changing dedup semantics.
// Pre-CAS installs wrote raw bytes directly at their literal path; those are
// treated as a "legacy" store here and lazily migrated into CAS on first read.

const CAS_BLOB_PREFIX_OPFS = '__cas_blobs__/';
const CAS_MANIFEST_PATH_OPFS = '__cas_manifest__.json';
// Real fs paths always start with '/', so these keys (which don't) can never
// collide with a legacy path-keyed entry in the same IDB object store.
const CAS_BLOB_KEY_PREFIX_IDB = 'cas:blob:';
const CAS_MANIFEST_KEY_IDB = 'cas:manifest';

async function casHash(content) {
  const digest = await crypto.subtle.digest('SHA-256', content);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function casLoadManifest() {
  try {
    const bytes = backend === 'opfs' ? await opfsRead(CAS_MANIFEST_PATH_OPFS) : await idbRead(CAS_MANIFEST_KEY_IDB);
    if (bytes === undefined) return undefined;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

async function casSaveManifest(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  if (backend === 'opfs') await opfsWrite(CAS_MANIFEST_PATH_OPFS, bytes);
  else await idbWrite(CAS_MANIFEST_KEY_IDB, bytes);
}

async function casGetBlob(hash) {
  try {
    return backend === 'opfs' ? await opfsRead(CAS_BLOB_PREFIX_OPFS + hash) : await idbRead(CAS_BLOB_KEY_PREFIX_IDB + hash);
  } catch {
    return undefined;
  }
}

async function casPutBlob(hash, content) {
  if (backend === 'opfs') await opfsWrite(CAS_BLOB_PREFIX_OPFS + hash, content);
  else await idbWrite(CAS_BLOB_KEY_PREFIX_IDB + hash, content);
}

async function casDeleteBlob(hash) {
  try {
    if (backend === 'opfs') await opfsRm(CAS_BLOB_PREFIX_OPFS + hash);
    else await idbDelete(CAS_BLOB_KEY_PREFIX_IDB + hash);
  } catch {
    /* already gone */
  }
}

async function legacyRead(path) {
  try {
    return backend === 'opfs' ? await opfsRead(path) : await idbRead(path);
  } catch {
    return undefined;
  }
}

async function legacyExists(path) {
  return backend === 'opfs' ? await opfsExists(path) : await idbExists(path);
}

async function legacyList(path) {
  try {
    const prefix = path.endsWith('/') ? path : path + '/';
    return backend === 'opfs' ? await opfsReaddir(path) : await idbKeys(prefix);
  } catch {
    return [];
  }
}

async function legacyRemove(path) {
  try {
    if (backend === 'opfs') await opfsRm(path);
    else await idbDelete(path);
  } catch {
    /* not present */
  }
}

let casState;

async function casEnsureState() {
  if (!casState) {
    casState = (await casLoadManifest()) || { paths: {}, refcounts: {} };
  }
  return casState;
}

function casNormalize(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

async function casDecRef(state, hash) {
  const next = (state.refcounts[hash] || 1) - 1;
  if (next <= 0) {
    delete state.refcounts[hash];
    await casDeleteBlob(hash);
  } else {
    state.refcounts[hash] = next;
  }
}

async function casWriteFile(path, content) {
  const state = await casEnsureState();
  path = casNormalize(path);
  const hash = await casHash(content);
  const prevHash = state.paths[path];
  if (prevHash === hash) return;
  if (prevHash) await casDecRef(state, prevHash);
  if (!state.refcounts[hash]) await casPutBlob(hash, content);
  state.refcounts[hash] = (state.refcounts[hash] || 0) + 1;
  state.paths[path] = hash;
  await casSaveManifest(state);
}

async function casReadFile(path) {
  const state = await casEnsureState();
  path = casNormalize(path);
  const hash = state.paths[path];
  if (hash) {
    const blob = await casGetBlob(hash);
    if (blob !== undefined) return blob;
  }
  const legacyContent = await legacyRead(path);
  if (legacyContent !== undefined) {
    await casWriteFile(path, legacyContent);
    await legacyRemove(path);
    return legacyContent;
  }
  throw new Error('ENOENT: ' + path);
}

async function casMkdir(path) {
  const state = await casEnsureState();
  path = casNormalize(path);
  if (Object.prototype.hasOwnProperty.call(state.paths, path)) return;
  state.paths[path] = null;
  await casSaveManifest(state);
}

async function casExists(path) {
  const state = await casEnsureState();
  path = casNormalize(path);
  if (Object.prototype.hasOwnProperty.call(state.paths, path)) return true;
  const prefix = path + '/';
  for (const p of Object.keys(state.paths)) {
    if (p.startsWith(prefix)) return true;
  }
  if (await legacyExists(path)) return true;
  return false;
}

async function casReaddir(path) {
  const state = await casEnsureState();
  path = casNormalize(path);
  const prefix = path === '' || path === '/' ? '/' : path + '/';
  const names = new Set();
  for (const p of Object.keys(state.paths)) {
    if (!p.startsWith(prefix) || p === path) continue;
    names.add(p.slice(prefix.length).split('/')[0]);
  }
  const legacyNames = await legacyList(path);
  for (const n of legacyNames) names.add(n);
  return Array.from(names);
}

async function casRm(path) {
  const state = await casEnsureState();
  path = casNormalize(path);
  if (Object.prototype.hasOwnProperty.call(state.paths, path)) {
    const hash = state.paths[path];
    delete state.paths[path];
    if (hash) await casDecRef(state, hash);
  }
  const prefix = path + '/';
  for (const p of Object.keys(state.paths)) {
    if (!p.startsWith(prefix)) continue;
    const hash = state.paths[p];
    delete state.paths[p];
    if (hash) await casDecRef(state, hash);
  }
  await legacyRemove(path);
  await casSaveManifest(state);
}

async function handle(msg) {
  try {
    let data;
    switch (msg.method) {
      case 'readFile': {
        data = await casReadFile(msg.path);
        break;
      }
      case 'writeFile': {
        const content = msg.content || new Uint8Array(0);
        await casWriteFile(msg.path, content);
        break;
      }
      case 'mkdir': {
        await casMkdir(msg.path);
        break;
      }
      case 'rm': {
        await casRm(msg.path);
        break;
      }
      case 'exists': {
        data = await casExists(msg.path);
        break;
      }
      case 'readdir': {
        data = await casReaddir(msg.path);
        break;
      }
    }
    return { id: msg.id, ok: true, data };
  } catch (err) {
    return { id: msg.id, ok: false, error: err?.message ?? String(err) };
  }
}

(async () => {
  backend = await detectBackend();
})();

self.onmessage = (e) => {
  handle(e.data).then(resp => self.postMessage(resp));
};
`;
