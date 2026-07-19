import type { Scenario } from "./types";
import { consoleHello } from "./console-hello/meta";
import { gitDemo } from "./git-demo/meta";

export type { Scenario, QuickAction } from "./types";

export const scenarios: Scenario[] = [consoleHello, gitDemo];
export const defaultScenario: Scenario = consoleHello;
