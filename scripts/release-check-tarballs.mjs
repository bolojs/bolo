// Asserts every packed tarball is publishable: no workspace: specifiers, license, repository, dist present.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
let bad = 0
const err = (m) => { console.error('  FAIL ' + m); bad++ }
for (const f of readdirSync(dir).filter((f) => f.endsWith('.tgz'))) {
  const pkg = JSON.parse(execFileSync('tar', ['-xOzf', join(dir, f), 'package/package.json'], { encoding: 'utf8' }))
  const files = execFileSync('tar', ['-tzf', join(dir, f)], { encoding: 'utf8' }).split('\n')
  console.log(`${pkg.name}@${pkg.version}`)
  for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies'])
    for (const [n, v] of Object.entries(pkg[k] ?? {}))
      if (String(v).startsWith('workspace:')) err(`${pkg.name} ${k}.${n} = ${v}`)
      else if (n.startsWith('@bolojs/') || n === 'bolojs') console.log(`  ${n} -> ${v}`)
  if (pkg.license !== 'Apache-2.0') err(`${pkg.name} license`)
  if (!pkg.repository?.url) err(`${pkg.name} repository`)
  if (pkg.publishConfig?.access !== 'public') err(`${pkg.name} publishConfig.access`)
  if (!files.some((p) => p === 'package/LICENSE')) err(`${pkg.name} LICENSE missing from tarball`)
  if (!files.some((p) => p.startsWith('package/dist/') && p.endsWith('.js'))) err(`${pkg.name} dist/*.js missing`)
}
if (bad) process.exit(1)
