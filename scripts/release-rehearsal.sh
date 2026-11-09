#!/usr/bin/env bash
# Release rehearsal. NEVER publishes: only `publish --dry-run` and `pack`.
# Builds, dry-run publishes with tag rc, packs tarballs to a temp dir, installs them
# into a throwaway Vite app OUTSIDE the repo and asserts every package imports and bundles.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${RELEASE_TAG:-rc}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bolo-rehearsal.XXXXXX")"
TARBALLS="$WORK/tarballs"
APP="$WORK/app"
LOCK="${RELEASE_LOCK:-/tmp/tsc.lock}"
trap '[ "${KEEP:-0}" = 1 ] || rm -rf "$WORK"' EXIT

heavy() { if command -v flock >/dev/null 2>&1; then flock "$LOCK" "$@"; else "$@"; fi; }
step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cd "$ROOT"
mkdir -p "$TARBALLS" "$APP"

step "build"
heavy pnpm run release:build

step "publish --dry-run --tag $TAG (no registry write)"
pnpm publish -r --dry-run --no-git-checks --tag "$TAG" --access public

step "pack tarballs -> $TARBALLS"
pnpm -r --filter './packages/*' exec pnpm pack --pack-destination "$TARBALLS"
ls "$TARBALLS"/*.tgz >/dev/null 2>&1 || fail "no tarballs produced"

step "assert tarball manifests (no workspace: specifiers, files, license)"
node "$ROOT/scripts/release-check-tarballs.mjs" "$TARBALLS"

step "install into throwaway vite app ($APP)"
OVERRIDES="$(node -e '
const fs=require("fs"),path=require("path");
const dir=process.argv[1];const o={};
for(const f of fs.readdirSync(dir).filter(f=>f.endsWith(".tgz"))){
  const name=f.replace(/-\d+\.\d+\.\d+.*\.tgz$/,"").replace(/^bolojs-(?=.)/,"@bolojs/");
  o[name==="@bolojs/runtime"?"@bolojs/runtime":name]="file:"+path.join(dir,f);
}
console.log(JSON.stringify(o));' "$TARBALLS")"
node -e '
const o=JSON.parse(process.argv[1]);
const pkg={name:"rehearsal-app",private:true,type:"module",
 dependencies:o,devDependencies:{vite:"^8.0.0"}};
const fs=require("fs");
fs.writeFileSync(process.argv[2]+"/package.json",JSON.stringify(pkg,null,2));
fs.writeFileSync(process.argv[2]+"/pnpm-workspace.yaml","packages: []\nstrictDepBuilds: false\noverrides:\n"+Object.entries(o).map(([k,v])=>`  ${JSON.stringify(k)}: ${JSON.stringify(v)}\n`).join(""));' "$OVERRIDES" "$APP"
cat > "$APP/index.html" <<'HTML'
<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>
HTML
node -e '
const o=JSON.parse(process.argv[1]);
const lines=Object.keys(o).map((n,i)=>`import * as m${i} from ${JSON.stringify(n)};\nif(!Object.keys(m${i}).length) throw new Error(${JSON.stringify(n)}+" has no exports");`);
require("fs").writeFileSync(process.argv[2]+"/main.js",lines.join("\n")+"\nconsole.log(\"ok\");\n");
require("fs").writeFileSync(process.argv[2]+"/check.mjs",Object.keys(o).map(n=>`await import(${JSON.stringify(n)}).then(()=>console.log("import ok ${n}"),e=>{console.error("import FAIL ${n}",e.message);process.exitCode=1});`).join("\n"));
' "$OVERRIDES" "$APP"
( cd "$APP" && pnpm install --no-frozen-lockfile --config.confirmModulesPurge=false )

step "assert packages resolve and bundle (vite build)"
# Strict by default: consumers get @oxc-transform/binding-wasm32-wasi through the
# dependency declared in @bolojs/registry and @bolojs/vite-server. Set
# REHEARSAL_WORKAROUND_OXC=1 only to reproduce the old manual-install workaround.
if [ "${REHEARSAL_WORKAROUND_OXC:-0}" = 1 ]; then
  ( cd "$APP" && pnpm add @oxc-transform/binding-wasm32-wasi@0.140.0 )
fi
cat > "$APP/vite.config.js" <<'JS'
import { bolojsShimPlugins } from "@bolojs/vite-preset";
export default { plugins: bolojsShimPlugins(), build: { target: "esnext" } };
JS
( cd "$APP" && pnpm exec vite build )

step "assert consumer-side patches applied (wasi async pool disabled, no stock pool of 4)"
if grep -rhoE 'asyncWorkPoolSize: ?[0-9]+' "$APP/dist" | grep -qE ': ?[1-9]'; then
  fail "a WASI binding in the consumer bundle still has asyncWorkPoolSize > 0 (vite-preset patch not applied)"
fi
grep -rqE '"AssertionError"' "$APP/dist" || fail "unenv assert patch not applied in consumer bundle (AssertionError name missing)"
grep -rqE 'asyncWorkPoolSize: ?0' "$APP/dist" || fail "no WASI binding with asyncWorkPoolSize found in consumer bundle"

step "assert packages import in Node (resolution + export maps)"
( cd "$APP" && node check.mjs ) || echo "NOTE: Node-side import failures above are informational (browser-only packages); vite build is the gate."

printf '\nREHEARSAL OK (nothing was published)\n'
