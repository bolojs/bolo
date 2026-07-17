import type { OutputCallbacks } from "../shell-service.js";

export const curl = async (args: string[], output: OutputCallbacks): Promise<number> => {
  let url = "";
  let method = "";
  const headers = new Headers();
  let body: string | undefined;
  let silent = false;
  let followRedirects = false;
  let head = false;
  let fail = false;
  let verbose = false;
  let outputFile: string | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-X" || arg === "--request") {
      method = args[++i] ?? method;
    } else if (arg === "-H" || arg === "--header") {
      const header = args[++i];
      if (header) {
        const separatorIndex = header.indexOf(":");
        if (separatorIndex > 0) {
          const key = header.slice(0, separatorIndex).trim();
          const value = header.slice(separatorIndex + 1).trim();
          headers.set(key, value);
        }
      }
    } else if (arg === "-d" || arg === "--data") {
      body = args[++i] ?? body;
    } else if (arg === "-o" || arg === "--output") {
      outputFile = args[++i] ?? outputFile;
    } else if (arg === "-s" || arg === "--silent") {
      silent = true;
    } else if (arg === "-L" || arg === "--location") {
      followRedirects = true;
    } else if (arg === "-I" || arg === "--head") {
      head = true;
    } else if (arg === "-f" || arg === "--fail") {
      fail = true;
    } else if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (!arg.startsWith("-")) {
      url = arg;
    }
    i++;
  }

  if (!url) {
    output.stderr("curl: no URL provided\n");
    return 2;
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  if (head) {
    method = "HEAD";
  } else if (!method) {
    method = body !== undefined ? "POST" : "GET";
  }

  const requestInit: RequestInit = {
    method,
    headers,
    redirect: followRedirects ? "follow" : "manual",
  };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    requestInit.body = body;
  }

  try {
    const response = await fetch(url, requestInit);
    const urlObj = new URL(url);

    if (verbose) {
      output.stderr(`> ${method} ${urlObj.pathname}${urlObj.search} HTTP/1.1\n`);
      output.stderr(`> Host: ${urlObj.host}\n`);
      for (const [key, value] of headers.entries()) {
        output.stderr(`> ${key}: ${value}\n`);
      }
      output.stderr(">\n");
      output.stderr(`< HTTP/1.1 ${response.status} ${response.statusText}\n`);
      for (const [key, value] of response.headers.entries()) {
        output.stderr(`< ${key}: ${value}\n`);
      }
      output.stderr("<\n");
    }

    if (fail && response.status >= 400) {
      if (!silent) output.stderr(`curl: HTTP ${response.status}\n`);
      return 22;
    }

    if (head) {
      const lines = [`HTTP/1.1 ${response.status} ${response.statusText}`];
      for (const [key, value] of response.headers.entries()) {
        lines.push(`${key}: ${value}`);
      }
      output.stdout(lines.join("\n") + "\n");
      return 0;
    }

    const bodyBuffer = await response.arrayBuffer();
    if (outputFile) {
      const vfs = (
        globalThis as unknown as {
          __vfsBus?: { writeFile: (path: string, content: string | Uint8Array) => Promise<void> };
        }
      ).__vfsBus;
      if (!vfs) {
        output.stderr("curl: -o requires __vfsBus but it is not set\n");
        return 1;
      }
      await vfs.writeFile(outputFile, new Uint8Array(bodyBuffer));
    } else {
      output.stdout(new TextDecoder().decode(bodyBuffer));
    }
    return 0;
  } catch (err) {
    output.stderr(`curl: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
};
