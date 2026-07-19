import { describe, it, expect, vi } from "vitest";
import { VfsBus } from "@bolojs/vfs-bus";
import type { PackageManager } from "@bolojs/npm";
import type { SWSandbox } from "@bolojs/sw-sandbox";
import { RuntimeBuilder } from "./runtime-builder.js";
import { boot } from "./boot.js";
import { BrowserContainer, type BrowserContainerDeps } from "./container.js";
import type { ShellService } from "./shell-service.js";

vi.mock("@bolojs/sw-sandbox", () => ({
  SWSandbox: {
    create: vi.fn().mockResolvedValue({
      onFetch: vi.fn(),
      setPolicyRegistry: vi.fn(),
    }),
  },
}));

vi.mock("./iframe-sandbox.js", () => ({
  IframeSandbox: class {
    init = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn();
    run = vi.fn().mockResolvedValue({ result: "" });
  },
}));

const baseOptions = { dangerouslyAllowSameOrigin: true };

describe("runtime-builder", () => {
  it("default build matches boot() output", async () => {
    const fromBuilder = await new RuntimeBuilder(baseOptions).build();
    const fromBoot = await boot(baseOptions);
    try {
      expect(fromBuilder).toBeInstanceOf(BrowserContainer);
      expect(fromBoot).toBeInstanceOf(BrowserContainer);
      expect(fromBuilder.workdir).toBe(fromBoot.workdir);
      expect(fromBuilder.fs).toBeDefined();
      expect(fromBoot.fs).toBeDefined();
      expect(typeof fromBuilder.spawn).toBe("function");
      expect(typeof fromBoot.spawn).toBe("function");
    } finally {
      await fromBuilder.teardown();
      await fromBoot.teardown();
    }
  });

  it("subclass can override createPackageManager", async () => {
    const packageManagerStub = {
      install: vi.fn(),
    } as unknown as PackageManager;

    class TestBuilder extends RuntimeBuilder {
      createPackageManager(_vfs: VfsBus): PackageManager {
        return packageManagerStub;
      }

      createContainer(deps: BrowserContainerDeps): BrowserContainer {
        const container = new BrowserContainer(deps);
        (container as BrowserContainer & { packageManager: PackageManager }).packageManager =
          packageManagerStub;
        return container;
      }
    }

    const builder = new TestBuilder(baseOptions);
    const container = await builder.build();
    try {
      expect(
        (container as BrowserContainer & { packageManager: PackageManager }).packageManager,
      ).toBe(packageManagerStub);
    } finally {
      await container.teardown();
    }
  });

  it("subclass can skip vite-server creation", async () => {
    const sandboxStub = { onFetch: vi.fn(), setPolicyRegistry: vi.fn() };

    class NoViteBuilder extends RuntimeBuilder {
      async createSandbox(): Promise<SWSandbox> {
        return sandboxStub as unknown as SWSandbox;
      }

      createViteServer(_vfs: VfsBus): undefined {
        return undefined;
      }
    }

    const builder = new NoViteBuilder(baseOptions);
    const container = await builder.build();
    try {
      expect(container).toBeInstanceOf(BrowserContainer);
      expect(sandboxStub.onFetch).not.toHaveBeenCalled();
    } finally {
      await container.teardown();
    }
  });

  it("boot: uses injected shellService when provided", async () => {
    const shellServiceStub = {
      execute: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as ShellService;

    const builder = new RuntimeBuilder({ ...baseOptions, shellService: shellServiceStub });
    const container = await builder.build();
    try {
      container.spawn("hello");
      expect(shellServiceStub.execute).toHaveBeenCalledWith("hello", expect.any(Object));
    } finally {
      await container.teardown();
    }
  });

  it("boot: uses vfsFactory when provided", async () => {
    const seededVfs = new VfsBus();
    await seededVfs.mkdir("/home/web", { recursive: true });
    await seededVfs.writeFile("/home/web/seed.txt", "seeded");

    class CapturingBuilder extends RuntimeBuilder {
      createContainer(deps: BrowserContainerDeps): BrowserContainer {
        const container = new BrowserContainer(deps);
        (container as BrowserContainer & { vfs: VfsBus }).vfs = deps.vfs;
        return container;
      }
    }

    const builder = new CapturingBuilder({ ...baseOptions, vfsFactory: () => seededVfs });
    const container = await builder.build();
    try {
      expect((container as BrowserContainer & { vfs: VfsBus }).vfs).toBe(seededVfs);
      const contents = await container.fs.readFile("/home/web/seed.txt");
      expect(contents).toBe("seeded");
    } finally {
      await container.teardown();
    }
  });

  it("boot: defaults unchanged when options absent", async () => {
    const fromBuilder = await new RuntimeBuilder({}).build();
    const fromBoot = await boot({});
    try {
      expect(fromBuilder).toBeInstanceOf(BrowserContainer);
      expect(fromBoot).toBeInstanceOf(BrowserContainer);
      expect(fromBuilder.workdir).toBe(fromBoot.workdir);
      expect(fromBuilder.fs).toBeDefined();
      expect(fromBoot.fs).toBeDefined();
      expect(typeof fromBuilder.spawn).toBe("function");
      expect(typeof fromBoot.spawn).toBe("function");
    } finally {
      await fromBuilder.teardown();
      await fromBoot.teardown();
    }
  });
});
