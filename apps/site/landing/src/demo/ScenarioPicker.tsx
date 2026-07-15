/** @jsxImportSource solid-js */
import { scenarios, type Scenario } from "./scenarios";

interface Props {
  active: Scenario;
  disabled: boolean;
  onSelect(scenario: Scenario): void;
}

export default function ScenarioPicker(props: Props) {
  const handleChange = (e: Event & { currentTarget: HTMLSelectElement }) => {
    const scenario = scenarios.find((s) => s.id === e.currentTarget.value);
    if (scenario) props.onSelect(scenario);
  };

  return (
    <div class="flex items-center gap-2">
      <span class="text-[12px] uppercase tracking-wide text-muted">Scenario</span>
      <div class="relative inline-flex items-center">
        <select
          value={props.active.id}
          disabled={props.disabled}
          onChange={handleChange}
          aria-label="Scenario"
          class="appearance-none bg-transparent py-1 pl-0 pr-5 text-[13px] text-fg transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        >
          {scenarios.map((scenario) => (
            <option value={scenario.id}>{scenario.label}</option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          class="pointer-events-none absolute right-0 h-3 w-3 text-muted"
          fill="none"
          stroke="currentColor"
          stroke-width="1.25"
        >
          <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
    </div>
  );
}
