import type { Scenario } from "../types";
import indexTs from "./index.ts?raw";
import packageJson from "./package.json?raw";

// ponytail: clone demo uses the public CORS proxy at cors.isomorphic-git.org,
// which is rate-limited. The cloned repo lives in the VFS hot (memfs) layer,
// so .git/ evaporates on page reload.
export const gitDemo: Scenario = {
  id: "git-demo",
  label: "Git commands",
  description: "Run local git commands and clone a tiny public repo entirely in the browser.",
  files: {
    "package.json": packageJson,
    "index.ts": indexTs,
  },
  quickActions: [
    { label: "git init", command: "git", args: ["init"] },
    { label: "git status", command: "git", args: ["status"] },
    { label: "git log", command: "git", args: ["log", "--oneline"] },
    { label: "git clone demo", command: "git", args: ["clone", "https://github.com/octocat/Hello-World"] },
  ],
  servesHttp: false,
};
