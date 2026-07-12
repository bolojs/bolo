import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../compat/dist', import.meta.url));
const dest = fileURLToPath(new URL('../dist/compat', import.meta.url));

await cp(src, dest, { recursive: true });
