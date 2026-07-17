import { createNetShim } from "@bolojs/node-runtime-shims";
import type { OutputCallbacks } from "../shell-service.js";

const RELAY_MISSING = "tcping: __tcpRelay is not set. Configure a TCP relay to use net commands.";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const tcping = async (args: string[], output: OutputCallbacks): Promise<number> => {
  const relay = (globalThis as unknown as { __tcpRelay?: { url: string } }).__tcpRelay;
  if (!relay) {
    output.stderr(RELAY_MISSING + "\n");
    return 1;
  }

  let count = 4;
  let timeout = 5;
  let host: string | undefined;
  let port: number | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-c" || arg === "--count") {
      count = parseInt(args[++i] ?? "4", 10);
    } else if (arg === "-t" || arg === "--timeout") {
      timeout = parseFloat(args[++i] ?? "5");
    } else if (!arg.startsWith("-")) {
      if (host === undefined) host = arg;
      else if (port === undefined) port = parseInt(arg, 10);
    }
    i++;
  }

  if (!host || port === undefined || Number.isNaN(port)) {
    output.stderr("tcping: host and port required\n");
    return 1;
  }

  const net = createNetShim(undefined, { tcpRelay: relay });
  const rtts: number[] = [];
  let open = 0;
  let closed = 0;

  for (let probe = 0; probe < count; probe++) {
    const t0 = performance.now();
    const socket = net.connect({ host, port });
    let resolved = false;

    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        output.stdout(`${host} ${port} closed/no response\n`);
        closed++;
        resolve();
      }, timeout * 1000);

      socket.on("connect", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        const rtt = performance.now() - t0;
        rtts.push(rtt);
        output.stdout(`${host} ${port} open time=${rtt.toFixed(1)}ms\n`);
        open++;
        socket.destroy();
        resolve();
      });

      socket.on("error", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        output.stdout(`${host} ${port} closed/no response\n`);
        closed++;
        resolve();
      });
    });

    if (probe < count - 1) {
      await sleep(1000);
    }
  }

  output.stdout("\n--- tcping statistics ---\n");
  const lossPercent = count > 0 ? Math.round((closed / count) * 100) : 0;
  output.stdout(`${count} probes sent, ${open} open, ${closed} closed, ${lossPercent}% loss\n`);
  if (rtts.length > 0) {
    const min = Math.min(...rtts);
    const max = Math.max(...rtts);
    const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    output.stdout(`rtt min/avg/max = ${min.toFixed(1)}/${avg.toFixed(1)}/${max.toFixed(1)} ms\n`);
  }

  return open > 0 ? 0 : 1;
};
