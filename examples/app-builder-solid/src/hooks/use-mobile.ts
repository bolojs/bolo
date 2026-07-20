import { createSignal, onMount, onCleanup } from "solid-js";

const MOBILE_QUERY = "(max-width: 767px)";

/**
 * Solid port of `examples/app-builder/src/hooks/use-mobile.ts`.
 * Returns an accessor so consumers can read reactively; no `useEffect`
 * + setState dance — `onMount` registers the matchMedia listener and
 * `onCleanup` tears it down deterministically.
 */
export function useIsMobile(): () => boolean {
  const [isMobile, setIsMobile] = createSignal(
    window.matchMedia?.(MOBILE_QUERY).matches ?? false,
  );

  onMount(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    onCleanup(() => mql.removeEventListener("change", onChange));
  });

  return isMobile;
}
