// Consumer-side equivalent of the repo's pnpm patch for unenv@2.0.0-rc.24.
// pnpm `patchedDependencies` do not travel with published packages, so the
// fix is re-applied by the nodeWebShims() Vite plugin at transform time.
// unenv's AssertionError has no message, no name and a pass-through inspect().

const ASSERT_ID = /[\\/]unenv[\\/]dist[\\/]runtime[\\/]node[\\/]assert\.mjs(?:\?.*)?$/;

const OLD_CTOR = `		super();
		this.actual = options.actual;
		this.expected = options.expected;
		this.operator = options.operator || "";`;
const NEW_CTOR = `		const operator = options.operator || "";
		const message = options.message === undefined
			? \`\${inspect(options.actual)} \${operator} \${inspect(options.expected)}\`.trim()
			: options.message;
		super(message);
		this.name = "AssertionError";
		this.actual = options.actual;
		this.expected = options.expected;
		this.operator = operator;`;
const OLD_INSPECT = "const inspect = (val, opts) => val;";
const NEW_INSPECT = `const inspect = (val) => {
	if (typeof val === "string") return \`'\${val}'\`;
	if (val instanceof Error) return val.stack || val.message;
	if (typeof val === "function") return val.name ? \`[Function: \${val.name}]\` : "[Function (anonymous)]";
	try {
		const json = JSON.stringify(val);
		return json === undefined ? String(val) : json;
	} catch {
		return String(val);
	}
};`;

/** Returns patched source for unenv's assert module, or null when `id` is not that module or is already patched/unrecognized. */
export const patchUnenvAssert = (id: string, code: string): string | null => {
  if (!ASSERT_ID.test(id)) return null;
  if (!code.includes(OLD_CTOR) || !code.includes(OLD_INSPECT)) return null;
  return code.replace(OLD_CTOR, NEW_CTOR).replace(OLD_INSPECT, NEW_INSPECT);
};
