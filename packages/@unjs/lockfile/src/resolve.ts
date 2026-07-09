import type { InstallablePackage, LockfileGraph, LockedPackage } from "./graph.js";

export function resolve(graph: LockfileGraph, cwd = "."): InstallablePackage[] {
  const importer = graph.importers.find((i) => i.cwd === cwd) ?? graph.importers[0];
  if (!importer) {
    return [];
  }

  const directDeps = new Map<string, string>();
  for (const [name, spec] of Object.entries({
    ...importer.dependencies,
    ...importer.devDependencies,
    ...importer.optionalDependencies,
  })) {
    directDeps.set(name, spec);
  }

  const result: InstallablePackage[] = [];
  const seen = new Set<string>();

  for (const pkg of Array.from(graph.packages.values())) {
    if (!pkg.name || !pkg.version) continue;
    if (!pkg.resolvedUrl) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isDev = isDevPackage(pkg, directDeps);
    const isOptional = pkg.optional;

    result.push({
      name: pkg.name,
      version: pkg.version,
      url: pkg.resolvedUrl,
      integrity: pkg.integrity ?? "",
      dev: isDev,
      optional: isOptional,
      peerDependencies: pkg.peerDependencies,
    });
  }

  return result;
}

function isDevPackage(pkg: LockedPackage, directDeps: Map<string, string>): boolean {
  return pkg.dev || directDeps.has(pkg.name);
}
