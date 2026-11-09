import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function fixturePath(name: string): string {
  return join(__dirname, "fixtures", name);
}

export async function readFixture(name: string): Promise<string> {
  return readFile(fixturePath(name), "utf8");
}

export async function readFixtureBuffer(name: string): Promise<Buffer> {
  return readFile(fixturePath(name));
}

export function readFixtureSync(name: string): Buffer {
  return readFileSync(fixturePath(name));
}
