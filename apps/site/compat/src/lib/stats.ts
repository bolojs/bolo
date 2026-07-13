import data from '../data/packages.json';

// ponytail: packages.json cells are inferred as a literal-keyed object, but
// col.key is a runtime string keyed off the same columns — cast to a record.
type CellMap = Record<string, { status: string; note: string }>;

export interface CategorySummary {
  key: string;
  label: string;
  total: number;
  pass: number;
  partial: number;
  fail: number;
}

const measuredColumns = data.columns.filter((col) => col.measured);

function isSupported(status: string | undefined): boolean {
  return status === 'pass' || status === 'partial';
}

export function getHeadlineStat() {
  const total = data.rows.length * measuredColumns.length;
  let supported = 0;
  for (const row of data.rows) {
    for (const col of measuredColumns) {
      if (isSupported((row.cells as CellMap)[col.key]?.status)) supported += 1;
    }
  }
  return {
    supported,
    total,
    percent: total === 0 ? 0 : Math.round((supported / total) * 100),
    columns: measuredColumns.map((c) => c.label),
  };
}

export function getCategorySummaries(): CategorySummary[] {
  return data.categories.map((cat): CategorySummary => {
    const rows = data.rows.filter((r) => r.category === cat.key);
    let pass = 0;
    let partial = 0;
    let fail = 0;
    for (const row of rows) {
      for (const col of measuredColumns) {
        const status = (row.cells as CellMap)[col.key]?.status;
        if (status === 'pass') pass += 1;
        else if (status === 'partial') partial += 1;
        else if (status === 'fail') fail += 1;
      }
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
