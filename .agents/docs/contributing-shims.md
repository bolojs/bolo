
## Factory Pattern (Required)

All shims MUST use the factory pattern. Never import singleton instances directly.

```typescript
// correct
import type { VfsBus } from '@browser-containers/vfs-bus';
export const createFsShim = (vfs: VfsBus) => { ... };

// forbidden
import { vfsRegistry } from '@browser-containers/vfs-bus';
```

## Dependencies

Inject all dependencies at construction time. Shims must not reach outside their factory closure.

## Type-Shape Tests

Each shim should include a type-shape assertion:

```typescript
import type fs from 'node:fs';
const _check: typeof fs = shim as unknown as typeof fs;
```

## Sync Methods

Sync methods must throw with the message pattern:

```
${methodName} not supported in browser runtime
```

## Conventions

- Named exports only (no default exports)
- Arrow functions preferred
- Interfaces for object shapes, type aliases for unions
- No `as any` without a brief justification comment
