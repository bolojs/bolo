import { Moon, Sun } from "lucide-solid";
import type { ParentComponent } from "solid-js";

export type Theme = "dark" | "light";

interface Props {
  theme: Theme;
  onToggle(): void;
}

// ponytail: native <button title=...> over Radix Tooltip wrapper. Same
// affordance (hover text), zero deps, no portal/focus-trap ceremony for
// a one-word hint.
const ThemeToggle: ParentComponent<Props> = (props) => {
  const isDark = () => props.theme === "dark";
  const label = () => (isDark() ? "Switch to light theme" : "Switch to dark theme");
  return (
    <button
      type="button"
      class="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={() => props.onToggle()}
      title={label()}
      aria-label={label()}
      aria-pressed={isDark()}
    >
      {isDark() ? <Sun class="size-4" /> : <Moon class="size-4" />}
    </button>
  );
};

export default ThemeToggle;
