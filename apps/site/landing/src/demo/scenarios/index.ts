import type { Scenario } from "./types";
import { consoleHello } from "./console-hello/meta";

export type { Scenario, QuickAction } from "./types";

export const scenarios: Scenario[] = [consoleHello];
export const defaultScenario: Scenario = consoleHello;
