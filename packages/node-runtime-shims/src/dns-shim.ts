export interface DnsShimOptions {
  /**
   * DNS-over-HTTPS endpoint used for all lookups. Defaults to Cloudflare's DoH.
   */
  readonly dohEndpoint?: string;
}

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

export const createDnsShim = (options?: DnsShimOptions) => {
  const dohEndpoint = options?.dohEndpoint ?? "https://cloudflare-dns.com/dns-query";

  const query = (name: string, type: string): Promise<{ Answer?: Array<{ data: string }> }> =>
    fetch(`${dohEndpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
    }).then((r) => r.json() as Promise<{ Answer?: Array<{ data: string }> }>);

  const lookup = (hostname: string): Promise<{ address: string; family: number }> =>
    query(hostname, "A").then((j) => ({ address: j.Answer?.[0]?.data ?? "0.0.0.0", family: 4 }));

  const resolve4 = (hostname: string): Promise<string[]> =>
    query(hostname, "A").then((j) => j.Answer?.map((a) => a.data) ?? []);

  const resolve6 = (hostname: string): Promise<string[]> =>
    query(hostname, "AAAA").then((j) => j.Answer?.map((a) => a.data) ?? []);

  const reverse = (ip: string): Promise<string[]> =>
    query(ipToPtr(ip), "PTR").then((j) => j.Answer?.map((a) => a.data.replace(/\.$/, "")) ?? []);

  return { lookup, resolve4, resolve6, reverse };
};
