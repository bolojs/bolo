import React from "react";
import { StatusHoverCard } from "./StatusHoverCard";
import { StatusPopup } from "./StatusPopup";
import { STATUS_COLOR, statusLabel } from "../lib/status";

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
  categoryLabel?: string;
}

interface HeatCalendarProps {
  categories: Category[];
  rows: Row[];
  latest: Record<string, LatestInfo>;
}

const STUB_LINK = "https://github.com/bolojs/bolo/actions/workflows/compat-harness.yml";

// ponytail: group everything-but-node-core under one heading; node core APIs stand alone.
const TOP_NPM_PACKAGES_LABEL = "Top npm packages";

export function HeatCalendar({ categories, rows, latest }: HeatCalendarProps) {
  const labelByKey = new Map(categories.map((c) => [c.key, c.label]));

  const nodeCoreRows = rows.filter((r) => r.category === "node-core");
  const topRows = rows.filter((r) => r.category !== "node-core");
  const topCategoryKeys = [...new Set(topRows.map((r) => r.category))];

  return (
    <div className="heat-calendar" aria-label="Browser compatibility status grid">
      {topRows.length > 0 && (
        <section className="heat-calendar-category" data-category={topCategoryKeys.join(",")}>
          <h3 className="heat-calendar-heading">{TOP_NPM_PACKAGES_LABEL}</h3>
          <div className="heat-calendar-grid">{renderCells(topRows, labelByKey, latest)}</div>
        </section>
      )}

      {nodeCoreRows.length > 0 && (
        <section className="heat-calendar-category" data-category="node-core">
          <h3 className="heat-calendar-heading">Node core APIs</h3>
          <div className="heat-calendar-grid">{renderCells(nodeCoreRows, labelByKey, latest)}</div>
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
    const status = info?.status ?? "unknown";
    const date = info?.date ?? "no run yet";
    const link = info?.link ?? STUB_LINK;
    const categoryLabel = pkg.categoryLabel ?? labelByKey.get(pkg.category) ?? pkg.category;
    const tooltip = `${categoryLabel} — ${pkg.name} — ${date}: ${statusLabel(status)}`;

    return (
      <StatusHoverCard
        key={pkg.id}
        className="heat-calendar-package"
        ariaLabel={tooltip}
        dataName={pkg.name}
        dataCategory={pkg.category}
        popup={
          <StatusPopup
            name={pkg.name}
            status={status}
            categoryLabel={categoryLabel}
            date={date}
            link={link}
          />
        }
      >
        <span
          className="heat-calendar-cell"
          style={{
            backgroundColor: STATUS_COLOR[status] ?? STATUS_COLOR.unknown,
          }}
        />
      </StatusHoverCard>
    );
  });
}
