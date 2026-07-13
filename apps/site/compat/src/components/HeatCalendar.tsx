import React from 'react';

interface LatestInfo {
  status: string;
  date: string;
  link: string;
}

interface Category {
  key: string;
  label: string;
}

interface Row {
  id: string;
  name: string;
  category: string;
}

interface HeatCalendarProps {
  categories: Category[];
  rows: Row[];
  latest: Record<string, LatestInfo>;
}

const STATUS_COLOR: Record<string, string> = {
  pass: '#10b981',
  partial: '#f59e0b',
  fail: '#ef4444',
  unknown: '#e5e7eb',
};

const STUB_LINK =
  'https://github.com/browser-containers/browser-containers/actions/workflows/compat-harness.yml';

export function HeatCalendar({ categories, rows, latest }: HeatCalendarProps) {
  const grouped = categories.map((cat) => ({
    ...cat,
    rows: rows.filter((r) => r.category === cat.key),
  }));

  return (
    <div className="heat-calendar">
      {grouped.map((group) => (
        <section
          key={group.key}
          className="heat-calendar-category"
          data-category={group.key}
          aria-label={`${group.label} compatibility status grid`}
        >
          <h3 className="heat-calendar-heading">{group.label}</h3>
          <div className="heat-calendar-grid">
            {group.rows.map((pkg) => {
              const info = latest[pkg.id];
              const status = info?.status ?? 'unknown';
              const date = info?.date ?? 'no run yet';
              const link = info?.link ?? STUB_LINK;
              const tooltip = `${pkg.name} — ${date}: ${status}`;

              return (
                <a
                  key={pkg.id}
                  href={link}
                  target="_blank"
                  rel="noopener"
                  className="heat-calendar-package"
                  data-name={pkg.name}
                  data-category={group.key}
                  title={tooltip}
                >
                  <div
                    className="heat-calendar-cell"
                    style={{
                      backgroundColor: STATUS_COLOR[status] ?? STATUS_COLOR.unknown,
                    }}
                  />
                  <span className="heat-calendar-package-name">{pkg.name}</span>
                </a>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
