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

export class Resolver {
  private servers: string[];
  private readonly timeout?: number;
  private readonly channel?: string;

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

export const createDnsShim = (options?: DnsShimOptions) => {
  const resolver = new Resolver();
  resolver.setServers([options?.dohEndpoint ?? DEFAULT_ENDPOINT]);
  return {
    lookup: (hostname: string) => resolver.lookup(hostname),
    resolve4: (hostname: string) => resolver.resolve4(hostname),
    resolve6: (hostname: string) => resolver.resolve6(hostname),
    reverse: (ip: string) => resolver.reverse(ip),
  };
};
