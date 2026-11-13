import React, { useEffect, useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

export interface StatusHoverCardProps {
  /** Class applied to the trigger element (e.g. "heat-calendar-package"). */
  className: string;
  /** Accessible name for the trigger. */
  ariaLabel: string;
  /** Optional data-* hooks mirrored onto the trigger for tests/QA. */
  dataName?: string;
  dataCategory?: string;
  /** Popup body rendered inside the shared hover-card-content chrome. */
  popup: React.ReactNode;
  openDelay?: number;
  closeDelay?: number;
  children: React.ReactNode;
}

// Controlled HoverCard wrapper shared by calendar cells and listing rows.
// Control is only used to guarantee Escape closes the popup; open/close is
// otherwise driven by Radix hover/focus (desktop hover, touch tap, keyboard).
export function StatusHoverCard({
  className,
  ariaLabel,
  dataName,
  dataCategory,
  popup,
  openDelay = 200,
  closeDelay = 100,
  children,
}: StatusHoverCardProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={openDelay} closeDelay={closeDelay}>
      <HoverCardTrigger asChild>
        <div
          className={className}
          role="button"
          tabIndex={0}
          aria-label={ariaLabel}
          aria-expanded={open}
          data-name={dataName}
          data-category={dataCategory}
        >
          {children}
        </div>
      </HoverCardTrigger>
      <HoverCardContent>{popup}</HoverCardContent>
    </HoverCard>
  );
}
