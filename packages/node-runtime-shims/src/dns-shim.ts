import { isIP } from "./net-shim.js";
import { registerInternalBinding } from "@bolojs/node-web-shims/dist/internal/bindings.js";

export interface DnsShimOptions {
  /**
   * DNS-over-HTTPS endpoint used for all lookups. Defaults to Cloudflare's DoH.
   */
  readonly dohEndpoint?: string;
}

export interface DnsOptions {
  readonly timeout?: number;
  readonly channel?: string;
}

interface DohAnswer {
  data: string | string[];
}

interface DohResponse {
  Answer?: DohAnswer[];
}

interface MxRecord {
  priority: number;
  exchange: string;
}

interface SrvRecord {
  priority: number;
  weight: number;
  port: number;
  name: string;
}

interface NaptrRecord {
  order: number;
  preference: number;
  flags: string;
  services: string;
  regexp: string;
  replacement: string;
}

interface SoaRecord {
  nsname: string;
  hostmaster: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
}

const DEFAULT_ENDPOINT = "https://cloudflare-dns.com/dns-query";

const expandIPv6 = (ip: string): string => {
  const parts = ip.split(":");
  const emptyIndex = parts.indexOf("");
  if (emptyIndex !== -1) {
    const missing = 8 - (parts.length - 1);
    parts.splice(emptyIndex, 1, ...Array(missing).fill("0"));
  }
  return (
    parts
      .map((p) => p.padStart(4, "0"))
      .join("")
      .split("")
      .reverse()
      .join(".") + ".ip6.arpa"
  );
};

const ipToPtr = (ip: string): string => {
  if (ip.includes(".")) {
    return ip.split(".").reverse().join(".") + ".in-addr.arpa";
  }
  return expandIPv6(ip);
};

const asString = (data: string | string[]): string =>
  typeof data === "string" ? data : data.join("");

const parseNaptr = (data: string): NaptrRecord => {
  const tokens: string[] = [];
  const regex = /"(?:\\.|[^"\\])*"|[^\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(data)) !== null) {
    tokens.push(match[0]);
  }
  const [order, preference, flags, services, regexp, replacement] = tokens;
  const unquote = (value: string | undefined): string => value?.replace(/^"|"$/g, "") ?? "";
  return {
    order: Number(order),
    preference: Number(preference),
    flags: unquote(flags),
    services: unquote(services),
    regexp: unquote(regexp),
    replacement: unquote(replacement).replace(/\.$/, "") || ".",
  };
};

const invalidArgType = (name: string, expected: string, actual: unknown): TypeError =>
  Object.assign(
    new TypeError(
      `The "${name}" argument must be of type ${expected}. Received ${
        actual === null ? "null" : `type ${typeof actual}`
      }`,
    ),
    { code: "ERR_INVALID_ARG_TYPE" },
  );

export class Resolver {
  private servers: string[];
  private readonly timeout?: number;
  private readonly channel?: string;
  /** Addresses recorded by setLocalAddress (DoH cannot bind a local address). */
  private localAddresses: string[] = [];

  constructor(options?: DnsOptions) {
    this.servers = [DEFAULT_ENDPOINT];
    this.timeout = options?.timeout;
    this.channel = options?.channel;
  }

  getServers(): string[] {
    return [...this.servers];
  }

  setServers(servers: string[]): void {
    if (servers.length === 0) {
      throw new Error("Servers array must not be empty");
    }
    this.servers = [...servers];
  }

  /**
   * `resolver.setLocalAddress(...addresses)` — Node validates each address
   * is a string literal IP, allows at most one IPv4 and one IPv6, and
   * requires at least one argument. The values are recorded for API parity;
   * DoH lookups cannot bind a local address, so they do not affect queries.
   */
  setLocalAddress(...addresses: unknown[]): void {
    if (addresses.length === 0) {
      throw invalidArgType("address", "string", undefined);
    }
    let hasV4 = false;
    let hasV6 = false;
    for (const address of addresses) {
      if (typeof address !== "string") {
        throw invalidArgType("address", "string", address);
      }
      const family = isIP(address);
      if (family === 4) {
        if (hasV4) {
          throw new Error("Only one IPv4 address can be specified");
        }
        hasV4 = true;
      } else if (family === 6) {
        if (hasV6) {
          throw new Error("Only one IPv6 address can be specified");
        }
        hasV6 = true;
      } else {
        throw new Error(`Invalid IP address: ${address}`);
      }
    }
    this.localAddresses = addresses as string[];
  }

  getLocalAddress(): string[] {
    return [...this.localAddresses];
  }

  private query = (name: string, type: string): Promise<DohResponse> =>
    fetch(`${this.servers[0]}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
    }).then((r) => r.json() as Promise<DohResponse>);

  lookup(hostname: string): Promise<{ address: string; family: number }> {
    return this.query(hostname, "A").then((j) => {
      const data = j.Answer?.[0]?.data;
      return { address: data ? asString(data) : "0.0.0.0", family: 4 };
    });
  }

  resolve(hostname: string, rrtype = "A"): Promise<string[]> {
    const type = rrtype.toUpperCase();
    switch (type) {
      case "A":
      case "AAAA":
      case "CNAME":
      case "NS":
        return this.query(hostname, type).then(
          (j) => j.Answer?.map((a) => asString(a.data).replace(/\.$/, "")) ?? [],
        ) as Promise<string[]>;
      case "PTR":
        return this.resolvePtr(hostname);
      case "TXT":
        return this.resolveTxt(hostname) as unknown as Promise<string[]>;
      case "MX":
        return this.resolveMx(hostname) as unknown as Promise<string[]>;
      case "SRV":
        return this.resolveSrv(hostname) as unknown as Promise<string[]>;
      case "NAPTR":
        return this.resolveNaptr(hostname) as unknown as Promise<string[]>;
      case "SOA":
        return this.resolveSoa(hostname).then((record) => [record as unknown as string]);
      default:
        throw new Error(`Unsupported rrtype: ${rrtype}`);
    }
  }

  resolve4(hostname: string): Promise<string[]> {
    return this.query(hostname, "A").then((j) => j.Answer?.map((a) => asString(a.data)) ?? []);
  }

  resolve6(hostname: string): Promise<string[]> {
    return this.query(hostname, "AAAA").then((j) => j.Answer?.map((a) => asString(a.data)) ?? []);
  }

  resolveCname(hostname: string): Promise<string[]> {
    return this.query(hostname, "CNAME").then(
      (j) => j.Answer?.map((a) => asString(a.data).replace(/\.$/, "")) ?? [],
    );
  }

  resolveTxt(hostname: string): Promise<string[][]> {
    return this.query(hostname, "TXT").then(
      (j) =>
        j.Answer?.map((a) => (Array.isArray(a.data) ? a.data.map(String) : [String(a.data)])) ?? [],
    );
  }

  resolveMx(hostname: string): Promise<MxRecord[]> {
    return this.query(hostname, "MX").then(
      (j) =>
        j.Answer?.map((a) => {
          const data = asString(a.data);
          const [priority, ...exchangeParts] = data.split(" ");
          return {
            priority: Number(priority),
            exchange: exchangeParts.join(" ").replace(/\.$/, ""),
          };
        }) ?? [],
    );
  }

  resolveSrv(hostname: string): Promise<SrvRecord[]> {
    return this.query(hostname, "SRV").then(
      (j) =>
        j.Answer?.map((a) => {
          const data = asString(a.data);
          const [priority, weight, port, ...nameParts] = data.split(" ");
          return {
            priority: Number(priority),
            weight: Number(weight),
            port: Number(port),
            name: nameParts.join(" ").replace(/\.$/, ""),
          };
        }) ?? [],
    );
  }

  resolvePtr(ip: string): Promise<string[]> {
    return this.query(ipToPtr(ip), "PTR").then(
      (j) => j.Answer?.map((a) => asString(a.data).replace(/\.$/, "")) ?? [],
    );
  }

  resolveNaptr(hostname: string, flags?: string): Promise<NaptrRecord[]> {
    return this.query(hostname, "NAPTR").then((j) => {
      const records = j.Answer?.map((a) => parseNaptr(asString(a.data))) ?? [];
      if (flags) {
        return records.filter((record) => record.flags === flags);
      }
      return records;
    });
  }

  resolveSoa(hostname: string): Promise<SoaRecord> {
    return this.query(hostname, "SOA").then((j) => {
      const answer = j.Answer?.[0];
      if (!answer) {
        throw new Error("SOA record not found");
      }
      const data = asString(answer.data);
      const [nsname, hostmaster, serial, refresh, retry, expire, minimum] = data.split(/\s+/);
      return {
        nsname: nsname.replace(/\.$/, ""),
        hostmaster: hostmaster.replace(/\.$/, ""),
        serial: Number(serial),
        refresh: Number(refresh),
        retry: Number(retry),
        expire: Number(expire),
        minimum: Number(minimum),
      };
    });
  }

  resolveNs(hostname: string): Promise<string[]> {
    return this.query(hostname, "NS").then(
      (j) => j.Answer?.map((a) => asString(a.data).replace(/\.$/, "")) ?? [],
    );
  }

  reverse(ip: string): Promise<string[]> {
    return this.resolvePtr(ip);
  }
}

const defaultResolver = new Resolver();

export const resolve = (hostname: string, rrtype?: string): Promise<string[]> =>
  defaultResolver.resolve(hostname, rrtype);

export const resolve4 = (hostname: string): Promise<string[]> => defaultResolver.resolve4(hostname);

export const resolve6 = (hostname: string): Promise<string[]> => defaultResolver.resolve6(hostname);

export const resolveCname = (hostname: string): Promise<string[]> =>
  defaultResolver.resolveCname(hostname);

export const resolveTxt = (hostname: string): Promise<string[][]> =>
  defaultResolver.resolveTxt(hostname);

export const resolveMx = (hostname: string): Promise<MxRecord[]> =>
  defaultResolver.resolveMx(hostname);

export const resolveSrv = (hostname: string): Promise<SrvRecord[]> =>
  defaultResolver.resolveSrv(hostname);

export const resolvePtr = (ip: string): Promise<string[]> => defaultResolver.resolvePtr(ip);

export const resolveNaptr = (hostname: string, flags?: string): Promise<NaptrRecord[]> =>
  defaultResolver.resolveNaptr(hostname, flags);

export const resolveSoa = (hostname: string): Promise<SoaRecord> =>
  defaultResolver.resolveSoa(hostname);

export const resolveNs = (hostname: string): Promise<string[]> =>
  defaultResolver.resolveNs(hostname);

export const reverse = (ip: string): Promise<string[]> => defaultResolver.reverse(ip);

export const getServers = (): string[] => defaultResolver.getServers();

export const setServers = (servers: string[]): void => defaultResolver.setServers(servers);

// Result order is recorded for API parity (Node's default is 'verbatim');
// DoH answers arrive in resolver order and the shim does not re-sort them,
// which matches 'verbatim' semantics. Invalid values throw like Node.

export const DNS_ORDER_VERBATIM = 0;
export const DNS_ORDER_IPV4_FIRST = 1;
export const DNS_ORDER_IPV6_FIRST = 2;

type ResultOrder = "verbatim" | "ipv4first" | "ipv6first";

const ORDER_TO_CONST: Record<ResultOrder, number> = {
  verbatim: DNS_ORDER_VERBATIM,
  ipv4first: DNS_ORDER_IPV4_FIRST,
  ipv6first: DNS_ORDER_IPV6_FIRST,
};
const CONST_TO_ORDER = ["verbatim", "ipv4first", "ipv6first"] as const;

/** The `req` object Node passes to cares.getaddrinfo; oncomplete is the C++ callback seam. */
export interface GetAddrInfoReq {
  callback?: (err: unknown, address?: unknown, family?: number) => void;
  oncomplete?: (err: number, addresses: string[], family: number) => void;
  family?: number;
  hostname?: string;
}

export interface CaresWrapBinding {
  DNS_ORDER_VERBATIM: number;
  DNS_ORDER_IPV4_FIRST: number;
  DNS_ORDER_IPV6_FIRST: number;
  getDefaultVerbatim: () => boolean;
  setDefaultResultOrder: (order: number) => void;
  /** Not part of Node's binding surface; the JS shim reads the numeric order. */
  getDefaultOrder: () => number;
  getaddrinfo: (
    req: GetAddrInfoReq,
    hostname: string,
    family: number,
    hints: number,
    order: number,
  ) => number;
}

/**
 * `internalBinding('cares_wrap')` — owns the default result order (numeric)
 * and the getaddrinfo entry point dns.lookup/dns.promises.lookup route
 * through, so a test that monkey-patches `cares.getaddrinfo` observes the
 * same call Node's lib/dns.js would make: (req, hostname, family, hints,
 * order).
 */
export const createCaresWrapBinding = (resolver: Resolver): CaresWrapBinding => {
  let defaultOrder = DNS_ORDER_VERBATIM;
  return {
    DNS_ORDER_VERBATIM,
    DNS_ORDER_IPV4_FIRST,
    DNS_ORDER_IPV6_FIRST,
    getDefaultVerbatim: () => defaultOrder === DNS_ORDER_VERBATIM,
    setDefaultResultOrder: (order: number) => {
      defaultOrder = order;
    },
    getDefaultOrder: () => defaultOrder,
    getaddrinfo: (req, hostname, family, _hints, _order) => {
      resolver.lookup(String(hostname)).then(
        ({ address, family: fam }) => req.oncomplete?.(0, [address], fam || family || 4),
        () => req.oncomplete?.(1, [], family || 4),
      );
      return 0;
    },
  };
};

const lookupError = (hostname: string): Error & { code: string; syscall: string } =>
  Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname,
  });

interface LookupOptions {
  family?: number;
  hints?: number;
  all?: boolean;
}

const isValidOrder = (order: unknown): order is ResultOrder =>
  order === "verbatim" || order === "ipv4first" || order === "ipv6first";

const invalidOrderError = (order: unknown): TypeError =>
  Object.assign(
    new TypeError(
      `The argument 'order' must be one of: 'verbatim', 'ipv4first', 'ipv6first'. Received ${String(order)}`,
    ),
    { code: "ERR_INVALID_ARG_VALUE" },
  );

/**
 * dns.lookup callback path shared by `dns.lookup` and `dns.promises.lookup`:
 * both reach cares.getaddrinfo with the binding's current default order, so
 * a monkey-patched getaddrinfo records every call.
 */
const lookupViaBinding = (
  cares: CaresWrapBinding,
  hostname: string,
  options: LookupOptions | undefined,
  callback: ((err: unknown, address?: unknown, family?: number) => void) | undefined,
): GetAddrInfoReq => {
  if (typeof hostname !== "string") {
    throw invalidArgType("hostname", "string", hostname);
  }
  const family = options?.family ?? 0;
  const all = options?.all === true;
  const req: GetAddrInfoReq = {
    callback,
    family,
    hostname,
    oncomplete: (err, addresses, fam) => {
      if (typeof callback !== "function") return;
      if (err) {
        callback(lookupError(hostname));
      } else if (all) {
        callback(null, addresses.map((address) => ({ address, family: fam })));
      } else {
        callback(null, addresses[0], fam);
      }
    },
  };
  const err = cares.getaddrinfo(req, hostname, family, options?.hints ?? 0, cares.getDefaultOrder());
  if (err && typeof callback === "function") {
    queueMicrotask(() => callback(lookupError(hostname)));
  }
  return req;
};

const lookupPromise = (
  cares: CaresWrapBinding,
  hostname: string,
  options?: LookupOptions,
): Promise<{ address: string; family: number } | { address: string; family: number }[]> =>
  new Promise((resolve, reject) => {
    lookupViaBinding(cares, hostname, options, (err, address, family) => {
      if (err) reject(err);
      else if (options?.all) resolve(address as { address: string; family: number }[]);
      else resolve({ address: address as string, family: family ?? 4 });
    });
  });

const moduleCares = createCaresWrapBinding(defaultResolver);

let defaultResultOrder: ResultOrder = "verbatim";

export const setDefaultResultOrder = (order: ResultOrder): void => {
  if (!isValidOrder(order)) throw invalidOrderError(order);
  defaultResultOrder = order;
  moduleCares.setDefaultResultOrder(ORDER_TO_CONST[order]);
};
export const getDefaultResultOrder = (): ResultOrder => defaultResultOrder;

export const promises = {
  lookup: (hostname: string, options?: LookupOptions) => lookupPromise(moduleCares, hostname, options),
  resolve4: (hostname: string) => defaultResolver.resolve4(hostname),
  resolve6: (hostname: string) => defaultResolver.resolve6(hostname),
  reverse: (ip: string) => defaultResolver.reverse(ip),
  resolve: (hostname: string, rrtype?: string) => defaultResolver.resolve(hostname, rrtype),
  resolveCname: (hostname: string) => defaultResolver.resolveCname(hostname),
  resolveTxt: (hostname: string) => defaultResolver.resolveTxt(hostname),
  resolveMx: (hostname: string) => defaultResolver.resolveMx(hostname),
  resolveSrv: (hostname: string) => defaultResolver.resolveSrv(hostname),
  resolvePtr: (ip: string) => defaultResolver.resolvePtr(ip),
  resolveNs: (hostname: string) => defaultResolver.resolveNs(hostname),
  resolveSoa: (hostname: string) => defaultResolver.resolveSoa(hostname),
  resolveNaptr: (hostname: string, flags?: string) => defaultResolver.resolveNaptr(hostname, flags),
  setDefaultResultOrder,
  getDefaultResultOrder,
  Resolver,
};

export const createDnsShim = (options?: DnsShimOptions) => {
  const resolver = new Resolver();
  resolver.setServers([options?.dohEndpoint ?? DEFAULT_ENDPOINT]);
  // The cares_wrap binding owns the default result order and the getaddrinfo
  // seam every lookup flows through; registering it makes
  // `internalBinding('cares_wrap')` resolve to this instance's binding so a
  // monkey-patched getaddrinfo observes this container's lookups.
  const cares = createCaresWrapBinding(resolver);
  registerInternalBinding("cares_wrap", cares as unknown as Record<string, unknown>);
  const setOrder = (order: ResultOrder): void => {
    if (!isValidOrder(order)) throw invalidOrderError(order);
    cares.setDefaultResultOrder(ORDER_TO_CONST[order]);
  };
  const getOrder = (): ResultOrder => CONST_TO_ORDER[cares.getDefaultOrder()] ?? "verbatim";
  const shim = {
    // Node's dns.lookup is callback-based and flows through
    // cares.getaddrinfo with the binding's current default order
    // (test-dns-set-default-order).
    lookup: (
      hostname: string,
      lookupOptions?: LookupOptions | ((err: unknown, address?: unknown, family?: number) => void),
      callback?: (err: unknown, address?: unknown, family?: number) => void,
    ): GetAddrInfoReq => {
      let opts = lookupOptions;
      let cb = callback;
      if (typeof lookupOptions === "function") {
        cb = lookupOptions;
        opts = undefined;
      }
      return lookupViaBinding(cares, hostname, opts as LookupOptions | undefined, cb);
    },
    resolve: (hostname: string, rrtype?: string) => resolver.resolve(hostname, rrtype),
    resolve4: (hostname: string) => resolver.resolve4(hostname),
    resolve6: (hostname: string) => resolver.resolve6(hostname),
    resolveCname: (hostname: string) => resolver.resolveCname(hostname),
    resolveTxt: (hostname: string) => resolver.resolveTxt(hostname),
    resolveMx: (hostname: string) => resolver.resolveMx(hostname),
    resolveSrv: (hostname: string) => resolver.resolveSrv(hostname),
    resolvePtr: (ip: string) => resolver.resolvePtr(ip),
    resolveNaptr: (hostname: string, flags?: string) => resolver.resolveNaptr(hostname, flags),
    resolveSoa: (hostname: string) => resolver.resolveSoa(hostname),
    resolveNs: (hostname: string) => resolver.resolveNs(hostname),
    reverse: (ip: string) => resolver.reverse(ip),
    getServers: () => resolver.getServers(),
    setServers: (servers: string[]) => resolver.setServers(servers),
    // Constructor — required by packages that call `new dns.Resolver(...)`.
    Resolver,
    // Result-order control backed by this instance's cares_wrap binding.
    setDefaultResultOrder: setOrder,
    getDefaultResultOrder: getOrder,
    ADDRCONFIG: 1024,
    V4MAPPED: 2048,
    ALL: 256,
    // `dns/promises` subpath bound to this instance's resolver + binding.
    promises: {
      lookup: (hostname: string, lookupOptions?: LookupOptions) =>
        lookupPromise(cares, hostname, lookupOptions),
      resolve4: (hostname: string) => resolver.resolve4(hostname),
      resolve6: (hostname: string) => resolver.resolve6(hostname),
      reverse: (ip: string) => resolver.reverse(ip),
      resolve: (hostname: string, rrtype?: string) => resolver.resolve(hostname, rrtype),
      resolveCname: (hostname: string) => resolver.resolveCname(hostname),
      resolveTxt: (hostname: string) => resolver.resolveTxt(hostname),
      resolveMx: (hostname: string) => resolver.resolveMx(hostname),
      resolveSrv: (hostname: string) => resolver.resolveSrv(hostname),
      resolvePtr: (ip: string) => resolver.resolvePtr(ip),
      resolveNs: (hostname: string) => resolver.resolveNs(hostname),
      resolveSoa: (hostname: string) => resolver.resolveSoa(hostname),
      resolveNaptr: (hostname: string, flags?: string) => resolver.resolveNaptr(hostname, flags),
      setDefaultResultOrder: setOrder,
      getDefaultResultOrder: getOrder,
      Resolver,
    },
  };
  return shim;
};
