import { beforeEach, onTestFailed } from "vitest";
import { configureBoloLogging } from "@bolojs/log";

await configureBoloLogging();

beforeEach(() => {
  onTestFailed(() => {
    console.error("bolo diagnostics: .logs/latest.jsonl");
  });
});
