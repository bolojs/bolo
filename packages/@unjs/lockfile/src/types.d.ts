declare module "@yarnpkg/lockfile" {
  interface ParseResult {
    type: "success" | "merge" | "conflict";
    object: Record<
      string,
      {
        version: string;
        resolved?: string;
        integrity?: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        bin?: Record<string, string>;
      }
    >;
  }

  export function parse(content: string): ParseResult;
  export function stringify(data: unknown): string;
}

declare module "@hyrious/bun.lockb" {
  export function parse(buffer: ArrayBuffer | Uint8Array): string;
}
