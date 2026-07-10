import { describe, it, expect } from "vitest";
import { serializeNpmLockfile } from "./lockfile-writer.js";
import type { InstallablePackage } from "@unjs/lockfile";

const makePkg = (overrides: Partial<InstallablePackage> = {}): InstallablePackage => ({
  name: "lodash",
  version: "4.17.21",
  url: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  integrity: "sha512-xxx",
  dev: false,
  optional: false,
  peerDependencies: {},
  ...overrides,
});

describe("serializeNpmLockfile", () => {
  it("produces a valid package-lock.json v3 structure", () => {
    const installables = [makePkg()];
    const json = serializeNpmLockfile(installables, { lodash: "^4.17.0" });
    const lock = JSON.parse(json);

    expect(lock.lockfileVersion).toBe(3);
    expect(lock.name).toBe("app");
    expect(lock.version).toBe("1.0.0");
    expect(lock.packages[""].dependencies).toEqual({ lodash: "^4.17.0" });
  });

  it("writes each installable under node_modules/<name>", () => {
    const installables = [
      makePkg({ name: "react", version: "18.2.0", url: "https://reg/react.tgz" }),
      makePkg({ name: "react-dom", version: "18.2.0", url: "https://reg/react-dom.tgz" }),
    ];
    const lock = JSON.parse(serializeNpmLockfile(installables, {}));

    expect(lock.packages["node_modules/react"].version).toBe("18.2.0");
    expect(lock.packages["node_modules/react"].resolved).toBe("https://reg/react.tgz");
    expect(lock.packages["node_modules/react-dom"].version).toBe("18.2.0");
  });

  it("omits integrity when empty", () => {
    const installables = [makePkg({ integrity: "" })];
    const lock = JSON.parse(serializeNpmLockfile(installables, {}));

    expect(lock.packages["node_modules/lodash"].integrity).toBeUndefined();
  });

  it("includes peerDependencies when present", () => {
    const installables = [makePkg({ peerDependencies: { react: "^18.0.0" } })];
    const lock = JSON.parse(serializeNpmLockfile(installables, {}));

    expect(lock.packages["node_modules/lodash"].peerDependencies).toEqual({ react: "^18.0.0" });
  });

  it("uses custom root name and version", () => {
    const lock = JSON.parse(serializeNpmLockfile([], {}, "my-app", "2.3.4"));
    expect(lock.name).toBe("my-app");
    expect(lock.version).toBe("2.3.4");
  });
});
