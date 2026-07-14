import React from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card';

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

const STATUS_LABEL: Record<string, string> = {
  pass: 'pass',
  partial: 'partial',
  fail: 'fail',
  unknown: 'unknown',
};

const STUB_LINK =
  'https://github.com/browser-containers/browser-containers/actions/workflows/compat-harness.yml';

// ponytail: group everything-but-node-core under one heading; node core APIs stand alone.
const TOP_NPM_PACKAGES_LABEL = 'Top npm packages';

export function HeatCalendar({ categories, rows, latest }: HeatCalendarProps) {
  const labelByKey = new Map(categories.map((c) => [c.key, c.label]));

  const nodeCoreRows = rows.filter((r) => r.category === 'node-core');
  const topRows = rows.filter((r) => r.category !== 'node-core');
  const topCategoryKeys = [...new Set(topRows.map((r) => r.category))];

  return (
    <div className="heat-calendar" aria-label="Browser compatibility status grid">
      {topRows.length > 0 && (
        <section
          className="heat-calendar-category"
          data-category={topCategoryKeys.join(',')}
        >
          <h3 className="heat-calendar-heading">{TOP_NPM_PACKAGES_LABEL}</h3>
          <div className="heat-calendar-grid">
            {renderCells(topRows, labelByKey, latest)}
          </div>
        </section>
      )}

      {nodeCoreRows.length > 0 && (
        <section
          className="heat-calendar-category"
          data-category="node-core"
        >
          <h3 className="heat-calendar-heading">Node core APIs</h3>
          <div className="heat-calendar-grid">
            {renderCells(nodeCoreRows, labelByKey, latest)}
          </div>
        </section>
      )}
    </div>
  );
}

function renderCells(
  rows: Row[],
  labelByKey: Map<string, string>,
  latest: Record<string, LatestInfo>,
) {
  return rows.map((pkg) => {
    const info = latest[pkg.id];
    const status = info?.status ?? 'unknown';
    const date = info?.date ?? 'no run yet';
    const link = info?.link ?? STUB_LINK;
    const categoryLabel = labelByKey.get(pkg.category) ?? pkg.category;
    const tooltip = `${categoryLabel} — ${pkg.name} — ${date}: ${status}`;

    return (
      <HoverCard key={pkg.id} openDelay={200} closeDelay={100}>
        <HoverCardTrigger asChild>
          <div
            className="heat-calendar-package"
            data-name={pkg.name}
            data-category={pkg.category}
            role="button"
            tabIndex={0}
            aria-label={tooltip}
          >
            <span
              className="heat-calendar-cell"
              style={{
                backgroundColor:
                  STATUS_COLOR[status] ?? STATUS_COLOR.unknown,
              }}
            />
          </div>
        </HoverCardTrigger>
        <HoverCardContent>
          <div className="hover-card-header">
            <span className="hover-card-name">{pkg.name}</span>
            <span className={`hover-card-badge status-${status}`}>
              {STATUS_LABEL[status]}
            </span>
          </div>
          <div className="hover-card-category">{categoryLabel}</div>
          <div className="hover-card-date">{date}</div>
          <a
            href={link}
            target="_blank"
            rel="noopener"
            className="hover-card-link"
            onClick={(e) => e.stopPropagation()}
          >
            View CI run →
          </a>
        </HoverCardContent>
      </HoverCard>
    );
  });
}
