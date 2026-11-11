import type {
  FileSystemAPI,
  FileSystemTree,
  Process,
  SpawnOptions,
  Unsubscribe,
} from "./container-types.js";
import type { ContainerCheckpoint } from "./checkpoint.js";
import { createContainerCheckpoint } from "./checkpoint.js";
import type { ContainerEvents } from "./events.js";
import type { VfsBus } from "@bolojs/fs";
import type { MountAPI } from "./mount.js";
import type { ExportAPI } from "./export.js";
import type { ProcessDeps } from "./process.js";
import { createProcess } from "./process.js";
import type { ReplService, ReplResult } from "./repl-service.js";
import type { SandboxBackend } from "./sandbox-backend.js";

export interface BrowserContainerDeps {
  vfs: VfsBus;
  fs: FileSystemAPI;
  events: ContainerEvents;
  mountApi: MountAPI;
  exportApi: ExportAPI;
  processDeps: ProcessDeps;
  workdir: string;
  replService: ReplService;
  sandbox?: SandboxBackend;
}

export class BrowserContainer {
  readonly fs: FileSystemAPI;
  readonly workdir: string;
  private deps: BrowserContainerDeps;
  private tornDown = false;

  constructor(deps: BrowserContainerDeps) {
    this.deps = deps;
    this.fs = deps.fs;
    this.workdir = deps.workdir;
  }

  spawn(command: string, args?: string[], options?: SpawnOptions): Process {
    if (this.tornDown) {
      throw new Error("Container has been torn down");
    }
    return createProcess(command, args ?? [], options ?? {}, this.deps.processDeps);
  }

  async mount(tree: FileSystemTree): Promise<void> {
    if (this.tornDown) {
      throw new Error("Container has been torn down");
    }
    await this.deps.mountApi.mountTree(tree, this.workdir);
  }

  on(
    event: "port",
    listener: (port: number, type: "open" | "close", url: string) => void,
  ): Unsubscribe;
  on(event: "server-ready", listener: (port: number, url: string) => void): Unsubscribe;
  on(event: "port" | "server-ready", listener: (...args: any[]) => void): Unsubscribe {
    return (
      this.deps.events.on as (
        event: "port" | "server-ready",
        listener: (...args: any[]) => void,
      ) => Unsubscribe
    )(event, listener);
  }

  async export(): Promise<FileSystemTree> {
    if (this.tornDown) {
      throw new Error("Container has been torn down");
    }
    return this.deps.exportApi.exportTree(this.workdir);
  }

  async checkpoint(): Promise<ContainerCheckpoint> {
    if (this.tornDown) {
      throw new Error("Container has been torn down");
    }
    return createContainerCheckpoint(this.deps.vfs, this.deps.sandbox, this.workdir);
  }

  async startRepl(): Promise<void> {
    await this.deps.replService.start();
  }

  evalRepl(code: string): Promise<ReplResult> {
    return this.deps.replService.eval(code);
  }

  exitRepl(): void {
    this.deps.replService.dispose();
  }

  async teardown(): Promise<void> {
    if (this.tornDown) {
      return;
    }
    this.tornDown = true;
    this.deps.events.removeAllListeners();
    // Reclaim every process worker this container started. A worker that is
    // still running (a hung program, a server that never exits) keeps its
    // realm alive until the page closes; leaking one per container teardown
    // is what made the compat harness's renderer OOM and killed whole runs.
    this.deps.processDeps.shell.killAll?.();
    this.deps.vfs.destroy?.();
    this.deps.processDeps.runtimeWorker.dispose();
  }
}
