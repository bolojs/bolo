import React from "react";
import { statusLabel } from "../lib/status";

export interface StatusPopupProps {
  name: string;
  status: string;
  categoryLabel: string;
  date: string;
  link: string;
}

const STOP = (e: React.MouseEvent) => e.stopPropagation();

// The single popup shown for a package/API — identical for heat-calendar
// cells and listing rows.
export function StatusPopup({ name, status, categoryLabel, date, link }: StatusPopupProps) {
  return (
    <>
      <div className="hover-card-header">
        <span className="hover-card-name">{name}</span>
        <span className={`hover-card-badge status-${status}`}>{statusLabel(status)}</span>
      </div>
      <div className="hover-card-category">{categoryLabel}</div>
      <div className="hover-card-date">{date}</div>
      {status === "unsupported" && (
        <div className="hover-card-note">Won't work in the browser</div>
      )}
      <a
        href={link}
        target="_blank"
        rel="noopener"
        className="hover-card-link"
        onClick={STOP}
      >
        View CI run →
      </a>
    </>
  );
}
