/**
 * ANSI colour helpers matching Node's `internal/util/colors` interface as
 * used by the assertion-error diff renderer. In a browser environment there
 * is no tty, so Node renders diffs without colours; the shim mirrors that
 * (every escape sequence is empty) while keeping the same API shape.
 */

const wrap = (open: number, close: number): string => (open === 0 ? "" : `\u001b[${open}m`);

export const colors = {
  blue: "",
  green: "",
  red: "",
  white: "",
  /** Node calls `colors.refresh()` before rendering; a browser has no tty, so this is a no-op. */
  refresh: (): void => {},
  /** Exposed for parity with Node's module shape; unused by the shim. */
  codes: { open: wrap, close: (close: number): string => `\u001b[${close}m` },
  hasColors: (): boolean => false,
};
