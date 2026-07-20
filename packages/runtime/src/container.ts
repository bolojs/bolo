import type {
  FileSystemAPI,
  FileSystemTree,
  Process,
  SpawnOptions,
  Unsubscribe,
} from "./container-types.js";
import type { ContainerEvents } from "./events.js";
import type { VfsBus } from "@bolojs/fs";
import type { MountAPI } from "./mount.js";
import type { ExportAPI } from "./export.js";
import type { ProcessDeps } from "./process.js";
import { createProcess } from "./process.js";
import type { ReplService, ReplResult } from "./repl-service.js";

export interface BrowserContainerDeps {
  vfs: VfsBus;
  fs: FileSystemAPI;
  events: ContainerEvents;
  mountApi: MountAPI;
  exportApi: ExportAPI;
  processDeps: ProcessDeps;
  workdir: string;
  replService: ReplService;
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
    this.deps.vfs.destroy?.();
    this.deps.processDeps.runtimeWorker.dispose();
  }
}
