// node:dgram loopback backend — in-realm datagram delivery.
//
// Datagrams have no Web API equivalent, so the honest default for a
// browser container is a loopback: a socket bound in this realm can send
// to another socket bound in the same realm, and the datagram is
// delivered in-process. Destinations outside the realm stay unreachable
// and report a transport error (EHOSTUNREACH) rather than pretending the
// send succeeded.
//
// This mirrors how `net` defaults to the in-process `LoopbackTransport`:
// the real-socket semantics that map cleanly are preserved (ephemeral
// port allocation, bind/listen ordering, send callback with the byte
// count), and everything that cannot map is reported honestly.

import type { DgramSocketBackend, RemoteInfo } from "@bolojs/node-web-shims";

interface BoundSocket {
  readonly type: "udp4" | "udp6";
  readonly port: number;
  readonly address: string;
  deliver(msg: Uint8Array, rinfo: { address: string; port: number }): void;
}

const isWildcard = (address: string): boolean =>
  address === "0.0.0.0" ||
  address === "::" ||
  address === "*" ||
  address === "localhost" ||
  address === "127.0.0.1" ||
  address === "::1";

export interface DgramBackendFactory {
  createSocket(type: "udp4" | "udp6"): DgramSocketBackend;
}

const hostUnreachable = (address: string, port: number): Error =>
  Object.assign(new Error(`send EHOSTUNREACH ${address}:${port}`), {
    code: "EHOSTUNREACH",
    address,
    port,
  });

/**
 * A loopback datagram realm: every socket created by the factory shares
 * one address space, so `bind`/`send` behave like a single host.
 */
export const createLoopbackDgramBackend = (): DgramBackendFactory => {
  const sockets = new Map<string, BoundSocket>();
  let nextEphemeralPort = 49152;

  const key = (address: string, port: number): string => `${address}:${port}`;

  const allocatePort = (): number => {
    while (sockets.has(key("0.0.0.0", nextEphemeralPort))) nextEphemeralPort++;
    return nextEphemeralPort++;
  };

  const findTarget = (address: string, port: number): BoundSocket | undefined => {
    for (const socket of sockets.values()) {
      if (socket.port !== port) continue;
      if (isWildcard(socket.address) || isWildcard(address) || socket.address === address) {
        return socket;
      }
    }
    return undefined;
  };

  const create = (type: "udp4" | "udp6"): DgramSocketBackend => {
    const family = type === "udp4" ? "IPv4" : "IPv6";
    const listeners = new Set<(msg: Uint8Array, rinfo: RemoteInfo) => void>();
    let boundPort = 0;
    let boundAddress = type === "udp4" ? "0.0.0.0" : "::";
    let closed = false;

    const socket: BoundSocket = {
      type,
      get port(): number {
        return boundPort;
      },
      get address(): string {
        return boundAddress;
      },
      deliver: (msg, rinfo) => {
        for (const listener of listeners) listener(msg, { ...rinfo, family, size: msg.byteLength });
      },
    };

    return {
      bind(port: number, address: string, callback: (error: Error | null) => void): void {
        if (closed) {
          callback(
            Object.assign(new Error("Not running"), { code: "ERR_SOCKET_DGRAM_NOT_RUNNING" }),
          );
          return;
        }
        boundPort = port === 0 ? allocatePort() : port;
        boundAddress = address;
        sockets.set(key(address, boundPort), socket);
        callback(null);
      },
      send(
        msg: Uint8Array,
        port: number,
        address: string,
        callback: (error: Error | null, bytes?: number) => void,
      ): void {
        const target = findTarget(address, port);
        if (!target) {
          callback(hostUnreachable(address, port));
          return;
        }
        target.deliver(msg, { address: boundAddress, port: boundPort });
        callback(null, msg.byteLength);
      },
      close(callback: () => void): void {
        closed = true;
        sockets.delete(key(boundAddress, boundPort));
        callback();
      },
      address(): { address: string; family: "IPv4" | "IPv6"; port: number } {
        if (boundPort === 0) {
          throw Object.assign(new Error("Not connected"), {
            code: "ERR_SOCKET_DGRAM_NOT_CONNECTED",
          });
        }
        return { address: boundAddress, family, port: boundPort };
      },
      onMessage(listener: (msg: Uint8Array, rinfo: RemoteInfo) => void): void {
        listeners.add(listener);
      },
    };
  };

  return { createSocket: create };
};
