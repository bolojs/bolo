export const opfsWorkerScript = `
interface OpfsRequest {
  id: number;
  method: 'readFile' | 'writeFile' | 'mkdir' | 'readdir' | 'rm' | 'exists';
  path: string;
  content?: Uint8Array;
}

interface OpfsResponse {
  id: number;
  ok: true;
  data?: Uint8Array | string[] | boolean;
} | {
  id: number;
  ok: false;
  error: string;
}

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

async function opfsMkdir(path) {
  const root = await opfsGetRoot();
  await ensureDir(root, path);
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

async function handle(msg) {
  try {
    let data;
    switch (msg.method) {
      case 'readFile': {
        const content = backend === 'opfs' ? await opfsRead(msg.path) : await idbRead(msg.path);
        if (content === undefined) throw new Error('ENOENT: ' + msg.path);
        data = content;
        break;
      }
      case 'writeFile': {
        const content = msg.content || new Uint8Array(0);
        if (backend === 'opfs') await opfsWrite(msg.path, content);
        else await idbWrite(msg.path, content);
        break;
      }
      case 'mkdir': {
        if (backend === 'opfs') await opfsMkdir(msg.path);
        break;
      }
      case 'rm': {
        if (backend === 'opfs') await opfsRm(msg.path);
        else await idbDelete(msg.path);
        break;
      }
      case 'exists': {
        data = backend === 'opfs' ? await opfsExists(msg.path) : await idbExists(msg.path);
        break;
      }
      case 'readdir': {
        const prefix = msg.path.endsWith('/') ? msg.path : msg.path + '/';
        data = backend === 'opfs' ? await opfsReaddir(msg.path) : await idbKeys(prefix);
        break;
      }
    }
    return { id: msg.id, ok: true, data };
  } catch (err) {
    return { id: msg.id, ok: false, error: err?.message ?? String(err) };
  }
}

backend = await detectBackend();

self.onmessage = (e) => {
  handle(e.data).then(resp => self.postMessage(resp));
};
`;
