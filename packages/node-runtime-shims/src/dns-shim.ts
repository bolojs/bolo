export interface DnsShimOptions {
  // no VFS needed for DoH; reserved for future TCP/UDP fallback
}

export const createDnsShim = (_options?: DnsShimOptions) => {
  // Known registry IPs — bypass lookup for known registries
  const KNOWN: Record<string, { address: string; family: 4 | 6 }> = {
    "registry.npmjs.org": { address: "104.16.27.34", family: 4 },
    "registry.npmmirror.com": { address: "180.184.191.58", family: 4 },
    "registry.yarnpkg.com": { address: "104.16.131.35", family: 4 },
  };

  const lookup = (hostname: string): Promise<{ address: string; family: number }> => {
    if (KNOWN[hostname]) return Promise.resolve(KNOWN[hostname]);
    return fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { Accept: "application/dns-json" } },
    )
      .then((r) => r.json() as Promise<{ Answer?: Array<{ data: string }> }>)
      .then((j) => ({ address: j.Answer?.[0]?.data ?? "0.0.0.0", family: 4 }));
  };

  const resolve4 = (hostname: string): Promise<string[]> =>
    fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { Accept: "application/dns-json" },
    })
      .then((r) => r.json() as Promise<{ Answer?: Array<{ data: string }> }>)
      .then((j) => j.Answer?.map((a) => a.data) ?? []);

  const resolve6 = (hostname: string): Promise<string[]> =>
    fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=AAAA`, {
      headers: { Accept: "application/dns-json" },
    })
      .then((r) => r.json() as Promise<{ Answer?: Array<{ data: string }> }>)
      .then((j) => j.Answer?.map((a) => a.data) ?? []);

  const reverse = (_ip: string): Promise<string[]> => Promise.resolve([]);

  return { lookup, resolve4, resolve6, reverse };
};
