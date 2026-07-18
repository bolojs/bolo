/**
 * Content-addressed storage bookkeeping for the cold (OPFS/IDB) layer.
 *
 * Blobs are stored once per unique hash; the manifest maps logical paths to
 * blob hashes, and refcounts track how many paths reference each blob so a
 * blob is only deleted once nothing points at it anymore.
 *
 * This is a pure, backend-agnostic algorithm so it can be unit tested without
 * a browser. `opfs-worker-script.ts` implements the same algorithm inline
 * (it runs inside a classic Worker built from a Blob, so it can't import this
 * module) — keep the two in sync when changing dedup/refcount semantics.
 */

export interface CasManifestState {
  /** Logical path -> blob hash. `null` marks an explicit (possibly empty) directory. */
  paths: Record<string, string | null>;
  /** Blob hash -> number of paths currently referencing it. */
  refcounts: Record<string, number>;
}

export interface CasLegacyBackend {
  read(path: string): Promise<Uint8Array | undefined>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

export interface CasBlobBackend {
  getBlob(hash: string): Promise<Uint8Array | undefined>;
  putBlob(hash: string, content: Uint8Array): Promise<void>;
  deleteBlob(hash: string): Promise<void>;
  loadManifest(): Promise<CasManifestState | undefined>;
  saveManifest(state: CasManifestState): Promise<void>;
  /** Pre-CAS, path-keyed raw storage. Optional: enables lazy read-through migration. */
  legacy?: CasLegacyBackend;
}

export type HashFn = (content: Uint8Array) => Promise<string>;

export const sha256Hex: HashFn = async (content) => {
  const digest = await crypto.subtle.digest("SHA-256", content as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const normalize = (path: string): string => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);

export class CasStore {
  private state: CasManifestState | undefined;

  constructor(
    private readonly backend: CasBlobBackend,
    private readonly hash: HashFn = sha256Hex,
  ) {}

  private async ensureState(): Promise<CasManifestState> {
    if (!this.state) {
      this.state = (await this.backend.loadManifest()) ?? { paths: {}, refcounts: {} };
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    await this.backend.saveManifest(this.state!);
  }

  private async decRef(state: CasManifestState, hash: string): Promise<void> {
    const next = (state.refcounts[hash] ?? 1) - 1;
    if (next <= 0) {
      delete state.refcounts[hash];
      await this.backend.deleteBlob(hash);
    } else {
      state.refcounts[hash] = next;
    }
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const state = await this.ensureState();
    path = normalize(path);
    const hash = await this.hash(content);
    const prevHash = state.paths[path];
    if (prevHash === hash) return;
    if (prevHash) await this.decRef(state, prevHash);
    if (!state.refcounts[hash]) await this.backend.putBlob(hash, content);
    state.refcounts[hash] = (state.refcounts[hash] ?? 0) + 1;
    state.paths[path] = hash;
    await this.persist();
  }

  async readFile(path: string): Promise<Uint8Array> {
    const state = await this.ensureState();
    path = normalize(path);
    const hash = state.paths[path];
    if (hash) {
      const blob = await this.backend.getBlob(hash);
      if (blob !== undefined) return blob;
    }
    const legacyContent = await this.backend.legacy?.read(path);
    if (legacyContent !== undefined) {
      await this.writeFile(path, legacyContent);
      await this.backend.legacy?.remove(path);
      return legacyContent;
    }
    throw new Error(`ENOENT: ${path}`);
  }

  async mkdir(path: string): Promise<void> {
    const state = await this.ensureState();
    path = normalize(path);
    if (Object.prototype.hasOwnProperty.call(state.paths, path)) return;
    state.paths[path] = null;
    await this.persist();
  }

  async exists(path: string): Promise<boolean> {
    const state = await this.ensureState();
    path = normalize(path);
    if (Object.prototype.hasOwnProperty.call(state.paths, path)) return true;
    const prefix = `${path}/`;
    for (const p of Object.keys(state.paths)) {
      if (p.startsWith(prefix)) return true;
    }
    if (await this.backend.legacy?.exists(path)) return true;
    return false;
  }

  async readdir(path: string): Promise<string[]> {
    const state = await this.ensureState();
    path = normalize(path);
    const prefix = path === "" || path === "/" ? "/" : `${path}/`;
    const names = new Set<string>();
    for (const p of Object.keys(state.paths)) {
      if (!p.startsWith(prefix) || p === path) continue;
      names.add(p.slice(prefix.length).split("/")[0]);
    }
    const legacyNames = await this.backend.legacy?.list(path);
    if (legacyNames) for (const n of legacyNames) names.add(n);
    return [...names];
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const state = await this.ensureState();
    path = normalize(path);
    if (Object.prototype.hasOwnProperty.call(state.paths, path)) {
      const hash = state.paths[path];
      delete state.paths[path];
      if (hash) await this.decRef(state, hash);
    }
    if (opts?.recursive) {
      const prefix = `${path}/`;
      for (const p of Object.keys(state.paths)) {
        if (!p.startsWith(prefix)) continue;
        const hash = state.paths[p];
        delete state.paths[p];
        if (hash) await this.decRef(state, hash);
      }
    }
    await this.backend.legacy?.remove(path);
    await this.persist();
  }
}
