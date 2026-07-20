import { snapshot as snapshotVfs, restore as restoreVfs, type VfsBus } from "@bolojs/vfs-bus";

// boot() stashes the active container's VfsBus here (see packages/runtime/src/boot.ts).
// There is exactly one live container at a time, so this is the correct instance
// to snapshot/restore against — the package's own `vfsRegistry` default is a
// separate, unrelated singleton.
declare global {
  var __vfsBus: VfsBus | undefined;
}

const DB_NAME = "bolo-app-builder";
const STORE_NAME = "projects";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProjectSnapshot(projectId: string): Promise<void> {
  if (!globalThis.__vfsBus) return;
  const snap = snapshotVfs(globalThis.__vfsBus);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(snap, projectId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadProjectSnapshot(projectId: string): Promise<Record<string, unknown> | undefined> {
  const db = await openDb();
  const snap = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(projectId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return snap;
}

export function restoreProjectSnapshot(snap: Record<string, unknown>): void {
  if (!globalThis.__vfsBus) return;
  restoreVfs(snap, globalThis.__vfsBus);
}
