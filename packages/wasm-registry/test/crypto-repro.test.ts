import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { PackageManager } from "@bolojs/pm";
import { bundleEntry } from "../src/bundle";
import {
  crypto as cryptoShim,
  buffer as bufferShim,
  util as utilShim,
  stream as streamShim,
  zlib as zlibShim,
  events as eventsShim,
} from "@bolojs/node-web-shims";

/**
 * Real-package repro for bolo#95: install `jsonwebtoken` through the
 * PackageManager, bundle an entry that signs + verifies an HS256 token, and
 * execute it against the live shim registry. jws/jwa reach for
 * crypto.createHmac, crypto.timingSafeEqual, crypto.KeyObject and
 * crypto.createSecretKey/createPrivateKey/createPublicKey — all previously
 * unenv "not implemented" stubs.
 */
describe("wasm-registry: real-package crypto repro", () => {
  // rolldown's WASM backend can hit "memory access out of bounds" under
  // heavy parallel load (observed on CI and in full-repo runs) — retry.
  it(
    "installs jsonwebtoken via PackageManager and signs/verifies a token",
    { retry: 2 },
    async () => {
      const vfs = new VfsBus();
      vfs.hot.writeFileSync(
        "/package.json",
        JSON.stringify({ dependencies: { jsonwebtoken: "9.0.2" } }),
      );
      const pm = new PackageManager({ vfs, cwd: "/" });
      await pm.install();

      const entry = `
      import jwt from 'jsonwebtoken';
      const token = jwt.sign({ sub: 'subject-42' }, 'secret', { algorithm: 'HS256' });
      const decoded = jwt.verify(token, 'secret');
      if (decoded.sub !== 'subject-42') throw new Error('decode mismatch: ' + decoded.sub);
      console.log('JWT_OK', decoded.sub);
    `;
      vfs.hot.mkdirSync("/src", { recursive: true });
      vfs.hot.writeFileSync("/src/entry.ts", entry);

      const stdout: string[] = [];
      const processShim = {
        env: {},
        argv: [],
        version: "v20.0.0",
        versions: { node: "20.0.0" },
        platform: "browser",
        nextTick: (cb: (...a: unknown[]) => void, ...args: unknown[]) =>
          queueMicrotask(() => cb(...args)),
        cwd: () => "/",
        stdout: { write: (s: string) => stdout.push(s) },
        stderr: { write: (s: string) => stdout.push(s) },
      };
      const shims: Record<string, unknown> = {
        crypto: cryptoShim,
        buffer: bufferShim,
        util: utilShim,
        stream: streamShim,
        zlib: zlibShim,
        events: eventsShim,
        process: processShim,
      };

      const { code, warnings } = await bundleEntry("/src/entry.ts", {
        vfs,
        getShim: (builtin) => shims[builtin] as Record<string, unknown> | undefined,
      });

      expect(warnings).toEqual([]);

      (globalThis as unknown as { __browserContainers: unknown }).__browserContainers = { shims };
      try {
        await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
      } finally {
        delete (globalThis as { __browserContainers?: unknown }).__browserContainers;
      }

      expect(stdout.join("")).toContain("JWT_OK subject-42");
    },
    120_000,
  );
});
