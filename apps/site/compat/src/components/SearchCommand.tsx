import React, { useEffect, useMemo, useState } from "react";
import { StatusHoverCard } from "./StatusHoverCard";
import { StatusPopup } from "./StatusPopup";
import { STATUS_ORDER, statusLabel } from "../lib/status";

interface ListingRow {
  id: string;
  name: string;
  category: string;
  categoryLabel?: string;
}

interface LatestInfo {
  status?: string;
  date?: string;
  link?: string;
}

interface SearchCommandProps {
  rows: ListingRow[];
  latest: Record<string, LatestInfo>;
}

const STUB_LINK = "https://github.com/bolojs/bolo/actions/workflows/compat-harness.yml";

const DEFAULT_IDS = ["fetch", "axios", "node-fetch", "events", "stream", "buffer"];

const KIND_OPTIONS = [
  { key: "node", label: "node" },
  { key: "npm", label: "npm" },
] as const;

type Kind = (typeof KIND_OPTIONS)[number]["key"];

interface Entry {
  id: string;
  name: string;
  kind: Kind;
  categoryLabel: string;
  status: string;
  date: string;
  ciLink: string;
  pkgLink: string;
}

const kindFor = (row: ListingRow): Kind => (row.category === "node-core" ? "node" : "npm");

const pkgLinkFor = (row: ListingRow, kind: Kind): string =>
  kind === "node"
    ? `https://nodejs.org/api/${row.name}.html`
    : `https://www.npmjs.com/package/${row.name}`;

const STOP = (e: React.MouseEvent) => e.stopPropagation();

export function SearchCommand({ rows, latest }: SearchCommandProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<string>>(new Set());
  const [kindFilter, setKindFilter] = useState<ReadonlySet<Kind>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [shortcutHidden, setShortcutHidden] = useState(false);

  const entries = useMemo<Entry[]>(
    () =>
      rows.map((row) => {
        const kind = kindFor(row);
        const info = latest[row.id];
        return {
          id: row.id,
          name: row.name,
          kind,
          categoryLabel: row.categoryLabel ?? row.category,
          status: info?.status ?? "unknown",
          date: info?.date ?? "no run yet",
          ciLink: info?.link ?? STUB_LINK,
          pkgLink: pkgLinkFor(row, kind),
        };
      }),
    [rows, latest],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = entries.filter((e) => {
      if (term && !e.name.toLowerCase().includes(term)) return false;
      if (statusFilter.size > 0 && !statusFilter.has(e.status)) return false;
      if (kindFilter.size > 0 && !kindFilter.has(e.kind)) return false;
      return true;
    });
    if (!term) return matches;
    const rank = (e: Entry) => {
      const name = e.name.toLowerCase();
      if (name === term) return -2;
      if (name.startsWith(term)) return -1;
      return 0;
    };
    return [...matches].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [entries, query, statusFilter, kindFilter]);

  const isDefaultView = query.trim() === "" && statusFilter.size === 0 && kindFilter.size === 0;

  const defaultEntries = useMemo(() => {
    const ordered = DEFAULT_IDS.map((id) => entries.find((e) => e.id === id)).filter(
      (e): e is Entry => e != null,
    );
    const rest = entries.filter((e) => !DEFAULT_IDS.includes(e.id));
    return [...ordered, ...rest];
  }, [entries]);

  const remainingCount = defaultEntries.length - DEFAULT_IDS.filter((id) =>
    entries.some((e) => e.id === id),
  ).length;

  const toggleStatus = (status: string) =>
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  const toggleKind = (kind: Kind) =>
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const clearAll = () => {
    setQuery("");
    setStatusFilter(new Set<string>());
    setKindFilter(new Set<Kind>());
  };

  const hasActiveFilters = query.trim() !== "" || statusFilter.size > 0 || kindFilter.size > 0;

  // "/" focuses the search input from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        document.getElementById("search-command-input")?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const renderRow = (entry: Entry) => (
    <li
      className="search-command-item"
      key={entry.id}
      data-name={entry.name}
      data-status={entry.status}
      data-kind={entry.kind}
    >
      <StatusHoverCard
        className="search-command-row"
        ariaLabel={`${entry.name} — ${entry.categoryLabel} — ${statusLabel(entry.status)}`}
        popup={
          <StatusPopup
            name={entry.name}
            status={entry.status}
            categoryLabel={entry.categoryLabel}
            date={entry.date}
            link={entry.ciLink}
          />
        }
      >
        <span className="search-command-name-wrap">
          <span className={`search-command-dot status-${entry.status}`} aria-hidden="true" />
          <span className="search-command-name">{entry.name}</span>
          <span className="search-command-kind">{entry.kind}</span>
        </span>
        <span className="search-command-actions">
          <a
            className="search-command-btn"
            href={entry.ciLink}
            target="_blank"
            rel="noopener"
            onClick={STOP}
            aria-label={`CI run for ${entry.name}`}
          >
            CI
          </a>
          <a
            className="search-command-btn"
            href={entry.pkgLink}
            target="_blank"
            rel="noopener"
            onClick={STOP}
            aria-label={`${entry.kind === "node" ? "Node.js docs" : "npm"} page for ${entry.name}`}
          >
            {entry.kind === "node" ? "DOCS" : "NPM"}
          </a>
        </span>
        <span className="search-command-status">
          <span className="search-command-status-text">{statusLabel(entry.status)}</span>
        </span>
      </StatusHoverCard>
    </li>
  );

  return (
    <section className="search-command" aria-label="Library search">
      <div className="search-command-field">
        <label htmlFor="search-command-input" className="search-command-label visually-hidden">
          Search libraries
        </label>
        <div className="search-command-input-wrap">
          <span className="search-command-prompt" aria-hidden="true">
            ›
          </span>
          <input
            id="search-command-input"
            className="search-command-input"
            type="search"
            autoComplete="off"
            placeholder={`Search ${entries.length} libraries...`}
            aria-label="Search libraries"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setShortcutHidden(true)}
            onBlur={() => {
              if (!query) setShortcutHidden(false);
            }}
          />
          <kbd className={`search-command-shortcut${shortcutHidden ? " is-hidden" : ""}`} aria-hidden="true">
            /
          </kbd>
        </div>

        <div className="search-command-filters" role="group" aria-label="Filter libraries">
          {STATUS_ORDER.map((status) => {
            const active = statusFilter.has(status);
            return (
              <button
                key={status}
                type="button"
                className={`search-command-filter${active ? " is-active" : ""}`}
                aria-pressed={active}
                onClick={() => toggleStatus(status)}
              >
                <span className={`search-command-dot status-${status}`} aria-hidden="true" />
                {statusLabel(status)}
              </button>
            );
          })}
          <span className="search-command-filters-sep" aria-hidden="true" />
          {KIND_OPTIONS.map((kind) => {
            const active = kindFilter.has(kind.key);
            return (
              <button
                key={kind.key}
                type="button"
                className={`search-command-filter${active ? " is-active" : ""}`}
                aria-pressed={active}
                onClick={() => toggleKind(kind.key)}
              >
                {kind.label}
              </button>
            );
          })}
          {hasActiveFilters && (
            <button type="button" className="search-command-clear" onClick={clearAll}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="search-command-results">
        {isDefaultView ? (
          <div className="search-command-default">
            <div className="search-command-expand-block" data-expanded={expanded}>
              <ul className="search-command-list">{defaultEntries.map(renderRow)}</ul>
              <button
                type="button"
                className="search-command-expand"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
              >
                <span className="search-command-expand-collapsed">
                  + {remainingCount} more libraries
                </span>
                <span className="search-command-expand-expanded">− Show less</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="search-command-matches">
            <p className="search-command-heading" aria-live="polite">
              {filtered.length} librar{filtered.length === 1 ? "y" : "ies"} match
            </p>
            <ul className="search-command-list">{filtered.map(renderRow)}</ul>
          </div>
        )}
      </div>
    </section>
  );
}
