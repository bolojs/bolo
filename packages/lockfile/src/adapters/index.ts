import type { Format } from "../graph.js";

const textDecoder = new TextDecoder();

export function detectFormat(
  content: string | ArrayBuffer | Uint8Array,
  filename?: string,
): Format {
  const lowerName = filename?.toLowerCase() ?? "";

  if (lowerName.endsWith("bun.lockb")) {
    return "bun-binary";
  }
  if (lowerName.endsWith("bun.lock")) {
    return "bun-text";
  }
  if (lowerName === "pnpm-lock.yaml") {
    return "pnpm";
  }
  if (lowerName === "yarn.lock") {
    return detectYarnFormat(content);
  }
  if (lowerName === "package-lock.json") {
    return "npm";
  }

  return detectContentFormat(content);
}

function detectContentFormat(content: string | ArrayBuffer | Uint8Array): Format {
  const sample = getSample(content);

  if (isBinaryBun(sample, content)) {
    return "bun-binary";
  }
  if (sample.includes("__metadata:")) {
    return "yarn-berry";
  }
  if (sample.includes("lockfileVersion:")) {
    return "pnpm";
  }
  if (sample.includes("lockfileVersion")) {
    return "npm";
  }
  if (sample.includes("yarn lockfile v1")) {
    return "yarn";
  }
  if (sample.includes("# yarn lockfile v1")) {
    return "yarn";
  }
  if (sample.includes('"lockfileVersion"') || sample.includes('"packages"')) {
    return "npm";
  }
  if (sample.includes("workspaces") && sample.includes('"packages"')) {
    return "bun-text";
  }
  if (sample.includes("resolution:") && sample.includes("checksum:")) {
    return "yarn-berry";
  }
  if (sample.includes("@")) {
    return "yarn";
  }
  return "yarn";
}

function detectYarnFormat(content: string | ArrayBuffer | Uint8Array): Format {
  const sample = getSample(content);
  if (sample.includes("__metadata:")) {
    return "yarn-berry";
  }
  return "yarn";
}

function getSample(content: string | ArrayBuffer | Uint8Array): string {
  if (typeof content === "string") {
    return content.slice(0, 2048);
  }
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  return textDecoder.decode(bytes.slice(0, 2048));
}

function isBinaryBun(sample: string, content: string | ArrayBuffer | Uint8Array): boolean {
  if (!sample.startsWith("#!/usr/bin/env bun")) {
    return false;
  }
  if (typeof content === "string") {
    return false;
  }
  return true;
}
