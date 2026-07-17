import { createNetShim } from "@bolojs/node-runtime-shims";
import type { OutputCallbacks } from "../shell-service.js";

const RELAY_MISSING = "nc: __tcpRelay is not set. Configure a TCP relay to use net commands.";

const createNet = () => {
  const relay = (globalThis as unknown as { __tcpRelay?: { url: string } }).__tcpRelay;
  if (!relay) throw new Error(RELAY_MISSING);
  return createNetShim(undefined, { tcpRelay: relay });
};

const parseEscapes = (input: string): string =>
  input.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");

export const nc = async (args: string[], output: OutputCallbacks): Promise<number> => {
  let listen = false;
  let data: string | undefined;
  let timeout = 0;
  let scan = false;
  let host: string | undefined;
  let port: number | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-l" || arg === "--listen") {
      listen = true;
    } else if (arg === "-d" || arg === "--data") {
      data = args[++i];
    } else if (arg === "-w" || arg === "--wait") {
      timeout = parseFloat(args[++i] ?? "0");
    } else if (arg === "-z") {
      scan = true;
    } else if (arg === "-p" || arg === "--port") {
      const portArg = args[++i];
      if (portArg) port = parseInt(portArg, 10);
    } else if (!arg.startsWith("-")) {
      if (host === undefined) host = arg;
      else if (port === undefined) port = parseInt(arg, 10);
    }
    i++;
  }

  if (listen) {
    // nc -l [host] port or nc -l -p port
    if (port === undefined && host !== undefined) {
      port = parseInt(host, 10);
      host = undefined;
    }
    if (port === undefined || Number.isNaN(port)) {
      output.stderr("nc: listening port required\n");
      return 1;
    }
    const listenPort = port;

    try {
      return await new Promise((resolve) => {
        const net = createNet();
        const server = net.createServer();
        let resolved = false;

        const finish = (code: number) => {
          if (resolved) return;
          resolved = true;
          resolve(code);
        };

        server.on("error", (err: Error) => {
          output.stderr(`nc: ${err.message}\n`);
          finish(1);
        });

        server.listen(listenPort, "0.0.0.0", () => {
          output.stderr(`Listening on port ${listenPort}\n`);
        });

        server.on("connection", (socket) => {
          socket.on("data", (bytes: Uint8Array) => {
            output.stdout(new TextDecoder().decode(bytes));
          });
          socket.on("error", (err: Error) => {
            output.stderr(`nc: ${err.message}\n`);
          });
          socket.on("close", () => finish(0));
        });

        if (timeout > 0) {
          setTimeout(() => {
            server.close();
            finish(0);
          }, timeout * 1000);
        }
      });
    } catch (err) {
      output.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (!host || port === undefined || Number.isNaN(port)) {
    output.stderr("nc: host and port required\n");
    return 1;
  }

  try {
    return await new Promise((resolve) => {
      const net = createNet();
      const socket = net.connect({ host, port });
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const finish = (code: number) => {
        if (resolved) return;
        resolved = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve(code);
      };

      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          output.stderr("nc: connection timed out\n");
          socket.destroy();
          finish(1);
        }, timeout * 1000);
      }

      socket.on("connect", () => {
        if (scan) {
          socket.destroy();
          output.stdout(`Connection to ${host} ${port} port [tcp/*] succeeded!\n`);
          finish(0);
          return;
        }
        if (data !== undefined) {
          socket.write(new TextEncoder().encode(parseEscapes(data)));
          socket.end();
        }
      });

      socket.on("data", (bytes: Uint8Array) => {
        output.stdout(new TextDecoder().decode(bytes));
      });

      socket.on("error", (err: Error) => {
        output.stderr(`nc: ${err.message}\n`);
        finish(1);
      });

      socket.on("close", () => finish(0));
    });
  } catch (err) {
    output.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
};

// ponytail: interactive stdin is not supported because the shell does not stream
// stdin to individual commands. Use the -d flag to send outbound data.
