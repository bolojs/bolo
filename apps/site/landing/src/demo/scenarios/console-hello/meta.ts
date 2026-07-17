import type { Scenario } from "../types";
import indexTs from "./index.ts?raw";
import packageJson from "./package.json?raw";

export const consoleHello: Scenario = {
  id: "console-hello",
  label: "Console formatting (chalk)",
  description: "A minimal Node script using chalk to print colored output.",
  files: {
    "package.json": packageJson,
    "index.ts": indexTs,
  },
  quickActions: [
    { label: "Run app", command: "node", args: ["index.ts"] },
    { label: "List files", command: "ls", args: ["-l"] },
    { label: "Install deps", command: "npm", args: ["install"] },
    { label: "View package.json", command: "cat", args: ["package.json"] },
    { label: "Run REPL", command: "node", args: [] },
    { label: "Git status", command: "git", args: ["status"], reason: "no git shim" },
    { label: "npm build", command: "npm", args: ["run", "build"], reason: "no build script" },
  ],
  servesHttp: false,
};
