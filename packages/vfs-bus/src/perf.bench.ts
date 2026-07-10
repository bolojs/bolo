import { describe, bench } from "vitest";
import { VfsBus } from "./vfs-bus.js";

describe("VFS hot path (memfs)", () => {
  bench("writeFileSync x1000", () => {
    const vfs = new VfsBus();
    for (let i = 0; i < 1000; i++) {
      vfs.hot.writeFileSync(`/test/file-${i}.txt`, `content-${i}`);
    }
  });

  bench("readFileSync x1000 (after writes)", () => {
    const vfs = new VfsBus();
    for (let i = 0; i < 1000; i++) {
      vfs.hot.writeFileSync(`/test/file-${i}.txt`, `content-${i}`);
    }
    for (let i = 0; i < 1000; i++) {
      vfs.hot.readFileSync(`/test/file-${i}.txt`, "utf8");
    }
  });
});

describe("Snapshot build", () => {
  // Helper: pre-populate VFS with N files
  const populateVfs = (n: number): VfsBus => {
    const vfs = new VfsBus();
    for (let i = 0; i < n; i++) {
      vfs.hot.writeFileSync(`/workdir/file-${i}.txt`, `content-${i}`.repeat(10));
    }
    return vfs;
  };

  // Helper: walk dir + read all files (simulates snapshot build)
  const walkAndRead = (vfs: VfsBus, dir: string): void => {
    const entries = vfs.hot.readdirSync(dir, { withFileTypes: true }) as any[];
    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walkAndRead(vfs, fullPath);
      } else {
        vfs.hot.readFileSync(fullPath, "utf8");
      }
    }
  };

  bench("100 files", () => {
    const vfs = populateVfs(100);
    walkAndRead(vfs, "/workdir");
  });

  bench("500 files", () => {
    const vfs = populateVfs(500);
    walkAndRead(vfs, "/workdir");
  });

  bench("1000 files", () => {
    const vfs = populateVfs(1000);
    walkAndRead(vfs, "/workdir");
  });
});
