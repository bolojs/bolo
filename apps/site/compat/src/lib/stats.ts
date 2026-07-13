import data from "../data/packages.json";

// ponytail: packages.json only ships the browser column now, so stats can read
// that single cell directly instead of scanning measuredColumns.
type CellMap = Record<string, { status: string; note: string }>;

export interface CategorySummary {
  key: string;
  label: string;
  total: number;
  pass: number;
  partial: number;
  fail: number;
}

function isSupported(status: string | undefined): boolean {
  return status === "pass" || status === "partial";
}

export function getHeadlineStat() {
  const total = data.rows.length;
  const supported = data.rows.filter((row) =>
    isSupported((row.cells as CellMap).browser?.status),
  ).length;
  return {
    supported,
    total,
    percent: total === 0 ? 0 : Math.round((supported / total) * 100),
    columns: ["Browser"],
  };
}

export function getCategorySummaries(): CategorySummary[] {
  return data.categories.map((cat): CategorySummary => {
    const rows = data.rows.filter((r) => r.category === cat.key);
    let pass = 0;
    let partial = 0;
    let fail = 0;
    for (const row of rows) {
      const status = (row.cells as CellMap).browser?.status;
      if (status === "pass") pass += 1;
      else if (status === "partial") partial += 1;
      else if (status === "fail") fail += 1;
    }
    return { key: cat.key, label: cat.label, total: rows.length, pass, partial, fail };
  });
}

export function getPackageCount() {
  return data.rows.length;
}

export function getGeneratedAt() {
  return data.meta.generatedAt;
}
