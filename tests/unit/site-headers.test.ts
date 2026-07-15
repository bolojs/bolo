import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Cloudflare Pages applies EVERY _headers block whose path pattern matches a
// request, and appends duplicate header names instead of letting a more
// specific rule win. Two overlapping blocks that both set the same header
// (e.g. `/demo/*` and `/*` both setting Cross-Origin-Embedder-Policy) silently
// produce a response with two values for that header, which browsers reject
// for security headers like COEP. There's no build-time linter for this, so
// this test parses `_headers` and fails if any two path patterns that can
// match a common URL also set the same header name.
const headersPath = fileURLToPath(new URL('../../apps/site/_headers', import.meta.url))

interface HeaderBlock {
  pattern: string
  headers: Map<string, string>
}

function parseHeadersFile(content: string): HeaderBlock[] {
  const blocks: HeaderBlock[] = []
  let current: HeaderBlock | null = null

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue

    if (!/^\s/.test(rawLine)) {
      current = { pattern: line.trim(), headers: new Map() }
      blocks.push(current)
      continue
    }

    if (!current) continue
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    current.headers.set(key.toLowerCase(), value)
  }

  return blocks
}

// Only handles a single trailing wildcard, which is the only form used in
// this repo's _headers file. Two such patterns overlap if one's literal
// prefix starts with the other's.
function patternsOverlap(a: string, b: string): boolean {
  const prefixOf = (pattern: string) => pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
  const aHasWildcard = a.endsWith('*')
  const bHasWildcard = b.endsWith('*')
  const aPrefix = prefixOf(a)
  const bPrefix = prefixOf(b)

  if (!aHasWildcard && !bHasWildcard) return aPrefix === bPrefix
  return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix)
}

describe('apps/site/_headers', () => {
  const blocks = parseHeadersFile(readFileSync(headersPath, 'utf-8'))

  it('has at least one block', () => {
    expect(blocks.length).toBeGreaterThan(0)
  })

  it('does not set the same header from two overlapping path patterns', () => {
    const conflicts: string[] = []

    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = blocks[i]
        const b = blocks[j]
        if (!patternsOverlap(a.pattern, b.pattern)) continue

        for (const [key, aValue] of a.headers) {
          if (!b.headers.has(key)) continue
          const bValue = b.headers.get(key)
          conflicts.push(
            `"${key}" set by both "${a.pattern}" (${aValue}) and "${b.pattern}" (${bValue}) — ` +
            `Cloudflare Pages appends both instead of picking one, producing an invalid duplicate header`,
          )
        }
      }
    }

    expect(conflicts).toEqual([])
  })
})
