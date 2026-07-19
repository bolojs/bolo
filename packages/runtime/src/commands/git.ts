import type { ShellDeps } from "../shell-service.js";

export const git = async (args: string[], deps: ShellDeps): Promise<number> => {
  const { GitService } = await import("../git/git-service.js");
  const [subcommand, ...rest] = args;
  const service = new GitService({
    vfs: deps.vfs,
    cwd: deps.cwd,
    stdout: (line) => deps.stdout(`${line}\n`),
  });

  switch (subcommand) {
    case "init":
      return service.init(rest);
    case "clone":
      return service.clone(rest);
    case "status":
      return service.status(rest);
    case "add":
      return service.add(rest);
    case "commit":
      return service.commit(rest);
    case "log":
      return service.log(rest);
    case "branch":
      return service.branch(rest);
    case "checkout":
      return service.checkout(rest);
    case "fetch":
      return service.fetch(rest);
    case "pull":
      return service.pull(rest);
    case "push":
      return service.push(rest);
    case "remote":
      return service.remote(rest);
    case "diff":
      return service.diff(rest);
    default: {
      const supported = GitService.getSupported().join(", ");
      deps.stdout(`git: '${subcommand}' is not supported. Supported: ${supported}\n`);
      return 1;
    }
  }
};
