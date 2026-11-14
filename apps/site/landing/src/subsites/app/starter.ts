import type { RouteModule } from "./contract";

/**
 * Starter route files mounted into the container VFS on first boot. Route
 * files are plain JavaScript ESM modules with a default export shaped like
 * {@link RouteModule}; they carry no imports (the contract is injected into
 * the handler context), so they can be re-executed live on every save with
 * no bundling step and no server restart.
 */

export interface StarterRouteFile {
  /** VFS-relative path under the workdir. */
  file: string;
  method: RouteModule["method"];
  path: string;
  contents: string;
}

export const STARTER_PACKAGE_JSON = JSON.stringify(
  { name: "bolo-app", private: true, type: "module", version: "0.1.0" },
  null,
  2,
);

export const STARTER_ROUTES: StarterRouteFile[] = [
  {
    file: "routes/items.js",
    method: "GET",
    path: "/api/v1/items",
    contents: `const items = [
  { id: 1, name: "Edit routes/hello.js or this file", done: false },
  { id: 2, name: "Hit send again, no restart needed", done: true },
];

export default {
  method: "GET",
  path: "/api/v1/items",
  handler: async () => Response.json({ items }),
};
`,
  },
  {
    file: "routes/hello.js",
    method: "GET",
    path: "/api/v1/hello",
    contents: `export default {
  method: "GET",
  path: "/api/v1/hello",
  handler: async () => Response.json({ message: "hello from the bolo backend" }),
};
`,
  },
];
