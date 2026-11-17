import type { Accessor, JSX } from "solid-js";

export type TabKind = "code" | "request" | "preview" | "custom";

/**
 * One tab in the workbench tab strip. Bodies stay mounted and are hidden
 * with display:none while inactive so editor state and in-flight requests
 * survive tab switches.
 */
export interface WorkbenchTab {
  /** "code:/home/web/src/App.tsx" | "req:items" | "preview" */
  id: string;
  kind: TabKind;
  title: string;
  dirty?: boolean;
  /** Defaults to true; pinned tabs (e.g. Preview) pass false. */
  closable?: boolean;
  /** Extra cleanup when the tab is closed (e.g. drop its document record). */
  onClose?(): void;
  render(): JSX.Element;
}

/** A contextual sidebar view reachable from the activity rail. */
export interface SidebarView {
  /** "explorer" | "api" | "chat" */
  id: string;
  /** Activity rail glyph; unused when there is a single view (no rail). */
  icon?: JSX.Element;
  title: string;
  /** Default sidebar width in px (explorer ~240, chat ~380). */
  width?: number;
  render(): JSX.Element;
}

export interface StatusItem {
  id: string;
  side: "left" | "right";
  render(ctx: WorkbenchContext): JSX.Element;
}

/** A view hosted in the collapsible bottom panel (terminal, console, …). */
export interface PanelView {
  id: string;
  title: string;
  render(): JSX.Element;
}

/** Shell-state controls handed to status items (panel/sidebar toggles). */
export interface WorkbenchContext {
  sidebarVisible(): boolean;
  toggleSidebar(): void;
  panelVisible(): boolean;
  togglePanel(): void;
}

export interface WorkbenchTabsController {
  tabs: Accessor<WorkbenchTab[]>;
  activeId: Accessor<string | null>;
  /** Insert the tab if new, then activate it. */
  open(tab: WorkbenchTab): void;
  close(id: string): void;
  activate(id: string): void;
}

export interface WorkbenchShellProps {
  /** -> data-subsite */
  subsite: string;
  /** -> data-panels (e2e contract list) */
  panels: string[];
  /** -> data-boot-state */
  bootState: string;
  /** Extra attributes on the root element; function values are read reactively. */
  attrs?: Record<string, string | Accessor<string>>;
  /** First view is the default; a single view hides the activity rail. */
  sidebar?: SidebarView[];
  tabs?: WorkbenchTabsController;
  bottom?: PanelView[];
  status?: StatusItem[];
  /**
   * Pre-workbench empty state (e.g. the /ide template picker). While set it
   * replaces the rail/sidebar/tabs/bottom regions entirely; the status bar
   * still renders.
   */
  placeholder?: JSX.Element;
  /** Main-area content when no tab controller is provided. */
  children?: JSX.Element;
}
