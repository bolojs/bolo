// Truth-reset gating for /compat numbers.
//
// `node-compat.json` and `package-matrix.json` carry a `validated` field:
// `false` in the committed files until the fixed harness scorer has run, and
// `true` in files written by the compat-harness CLI (it only writes a report
// after every canary failed as expected). While either source is unvalidated,
// harness-sourced rows render as `pending` ("under re-validation") instead of
// showing stale measurements. Tool rows come from the hand-maintained
// tools.json and keep their status.

export const PENDING_STATUS = "pending";

export const PENDING_NOTE = "Under re-validation";

// "unsupported" = won't work in the browser: every remaining failure is
// platform-bound (lane C, no browser-faithful mapping) or the package has no
// browser-compatible build at all. Rendered grey, distinct from fixable red.
export const UNSUPPORTED_STATUS = "unsupported";

export const UNSUPPORTED_NOTE = "Won't work in the browser";

export const isValidated = (nodeCompat, packageMatrix) =>
  nodeCompat?.validated === true && packageMatrix?.validated === true;

export const isHarnessSourced = ({ tool, pkg, mod }) => !tool && Boolean(pkg || mod);

export const rowStatus = (validated, sources, measuredStatus) =>
  !validated && isHarnessSourced(sources) ? PENDING_STATUS : measuredStatus;
