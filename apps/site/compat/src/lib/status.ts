// Shared status palette + labels for the heat calendar and the listing.
// "unsupported" is the grey "won't work in browser" state emitted by
// scripts/build-data.js when every remaining failure is platform-bound.

export const STATUS_COLOR: Record<string, string> = {
  pass: "#10b981",
  partial: "#f59e0b",
  fail: "#ef4444",
  unsupported: "#6b7280",
  pending: "#94a3b8",
  unknown: "#e5e7eb",
};

export const STATUS_LABEL: Record<string, string> = {
  pass: "pass",
  partial: "partial",
  fail: "fail",
  unsupported: "unsupported",
  pending: "pending",
  unknown: "unknown",
};

// Order used for the listing's status filter buttons.
export const STATUS_ORDER = [
  "pass",
  "partial",
  "fail",
  "unsupported",
  "pending",
  "unknown",
] as const;

export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status;
