import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createDnsShim,
  Resolver,
  getServers,
  setServers,
  resolve,
  resolve4,
  resolve6,
  resolveTxt,
  resolveMx,
  resolveSrv,
  resolvePtr,
  resolveNaptr,
  resolveSoa,
  resolveNs,
  reverse,
} from "./dns-shim.js";

const DEFAULT_ENDPOINT = "https://cloudflare-dns.com/dns-query";

let fetchCalls: { url: string; init: RequestInit | undefined }[] = [];
let dohResponse: { Answer?: Array<{ data: string | string[] }> } = {
  Answer: [],
};

beforeEach(() => {
  fetchCalls = [];
  dohResponse = { Answer: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return Promise.resolve({
        json: () => Promise.resolve(dohResponse),
      } as Response);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDnsShim", () => {
  it("looks up A records via DoH", async () => {
    dohResponse = { Answer: [{ data: "1.2.3.4" }] };
    const dns = createDnsShim();
    const result = await dns.lookup("example.com");

    expect(result.address).toBe("1.2.3.4");
    expect(result.family).toBe(4);
  });

  it("queries PTR records and strips trailing dots for reverse", async () => {
    dohResponse = { Answer: [{ data: "example.com." }] };
    const dns = createDnsShim();
    const result = await dns.reverse("1.2.3.4");

    expect(result).toEqual(["example.com"]);
    const call = fetchCalls[0];
    expect(call.url).toContain("type=PTR");
    expect(call.url).toContain("name=4.3.2.1.in-addr.arpa");
    expect(call.init?.headers).toMatchObject({ Accept: "application/dns-json" });
  });

  it("uses the configured DoH endpoint", async () => {
    const customEndpoint = "https://doh.example/dns-query";
    const dns = createDnsShim({ dohEndpoint: customEndpoint });
    await dns.lookup("example.com");

    expect(fetchCalls[0].url.startsWith(customEndpoint)).toBe(true);
  });
});

describe("dns module-level functions", () => {
  beforeEach(() => {
    setServers([DEFAULT_ENDPOINT]);
  });

  it("resolve defaults to A records", async () => {
    dohResponse = { Answer: [{ data: "1.2.3.4" }, { data: "5.6.7.8" }] };
    const result = await resolve("example.com");

    expect(result).toEqual(["1.2.3.4", "5.6.7.8"]);
    expect(fetchCalls[0].url).toContain("type=A");
    expect(fetchCalls[0].url).toContain("name=example.com");
  });

  it("resolve with rrtype returns CNAME records", async () => {
    dohResponse = { Answer: [{ data: "cname.example.com." }] };
    const result = await resolve("example.com", "CNAME");

    expect(result).toEqual(["cname.example.com"]);
    expect(fetchCalls[0].url).toContain("type=CNAME");
  });

  it("resolve4 returns A records", async () => {
    dohResponse = { Answer: [{ data: "1.2.3.4" }] };
    const result = await resolve4("example.com");

    expect(result).toEqual(["1.2.3.4"]);
    expect(fetchCalls[0].url).toContain("type=A");
  });

  it("resolve6 returns AAAA records", async () => {
    dohResponse = { Answer: [{ data: "2001:db8::1" }] };
    const result = await resolve6("example.com");

    expect(result).toEqual(["2001:db8::1"]);
    expect(fetchCalls[0].url).toContain("type=AAAA");
  });

  it("resolveTxt returns TXT records as arrays of strings", async () => {
    dohResponse = {
      Answer: [{ data: "v=spf1 include:_spf.example.com ~all" }, { data: ["part1", "part2"] }],
    };
    const result = await resolveTxt("example.com");

    expect(result).toEqual([["v=spf1 include:_spf.example.com ~all"], ["part1", "part2"]]);
    expect(fetchCalls[0].url).toContain("type=TXT");
  });

  it("resolveMx returns MX records", async () => {
    dohResponse = {
      Answer: [{ data: "10 mail1.example.com." }, { data: "20 mail2.example.com." }],
    };
    const result = await resolveMx("example.com");

    expect(result).toEqual([
      { priority: 10, exchange: "mail1.example.com" },
      { priority: 20, exchange: "mail2.example.com" },
    ]);
    expect(fetchCalls[0].url).toContain("type=MX");
  });

  it("resolveSrv returns SRV records", async () => {
    dohResponse = { Answer: [{ data: "10 5 5060 sipserver.example.com." }] };
    const result = await resolveSrv("example.com");

    expect(result).toEqual([
      { priority: 10, weight: 5, port: 5060, name: "sipserver.example.com" },
    ]);
    expect(fetchCalls[0].url).toContain("type=SRV");
  });

  it("resolvePtr returns PTR records", async () => {
    dohResponse = { Answer: [{ data: "example.com." }] };
    const result = await resolvePtr("1.2.3.4");

    expect(result).toEqual(["example.com"]);
    expect(fetchCalls[0].url).toContain("type=PTR");
    expect(fetchCalls[0].url).toContain("name=4.3.2.1.in-addr.arpa");
  });

  it("resolveNaptr returns NAPTR records", async () => {
    dohResponse = {
      Answer: [
        {
          data: '100 10 "u" "E2U+sip" "!^.*$!sip:customer@example.com!" .',
        },
      ],
    };
    const result = await resolveNaptr("example.com");

    expect(result).toEqual([
      {
        order: 100,
        preference: 10,
        flags: "u",
        services: "E2U+sip",
        regexp: "!^.*$!sip:customer@example.com!",
        replacement: ".",
      },
    ]);
    expect(fetchCalls[0].url).toContain("type=NAPTR");
  });

  it("resolveSoa returns SOA record", async () => {
    dohResponse = {
      Answer: [
        {
          data: "ns.example.com. hostmaster.example.com. 2023010101 3600 600 86400 3600",
        },
      ],
    };
    const result = await resolveSoa("example.com");

    expect(result).toEqual({
      nsname: "ns.example.com",
      hostmaster: "hostmaster.example.com",
      serial: 2023010101,
      refresh: 3600,
      retry: 600,
      expire: 86400,
      minimum: 3600,
    });
    expect(fetchCalls[0].url).toContain("type=SOA");
  });

  it("resolveNs returns NS records", async () => {
    dohResponse = {
      Answer: [{ data: "a.iana-servers.net." }, { data: "b.iana-servers.net." }],
    };
    const result = await resolveNs("example.com");

    expect(result).toEqual(["a.iana-servers.net", "b.iana-servers.net"]);
    expect(fetchCalls[0].url).toContain("type=NS");
  });

  it("reverse returns hostnames for an IP", async () => {
    dohResponse = { Answer: [{ data: "example.com." }] };
    const result = await reverse("1.2.3.4");

    expect(result).toEqual(["example.com"]);
    expect(fetchCalls[0].url).toContain("type=PTR");
  });

  it("getServers returns the configured DoH endpoint", () => {
    expect(getServers()).toEqual([DEFAULT_ENDPOINT]);
  });

  it("setServers changes the module-level DoH endpoint", async () => {
    const customEndpoint = "https://doh.example/dns-query";
    setServers([customEndpoint]);
    dohResponse = { Answer: [{ data: "1.2.3.4" }] };
    await resolve("example.com");

    expect(getServers()).toEqual([customEndpoint]);
    expect(fetchCalls[0].url.startsWith(customEndpoint)).toBe(true);
  });
});

describe("Resolver", () => {
  it("instantiates with optional timeout and channel", () => {
    const resolver = new Resolver({ timeout: 5000, channel: "foo" });
    expect(resolver.getServers()).toEqual([DEFAULT_ENDPOINT]);
  });

  it("uses its own endpoint configuration independently", async () => {
    const customEndpoint = "https://doh.example/dns-query";
    const resolver = new Resolver();
    resolver.setServers([customEndpoint]);
    dohResponse = { Answer: [{ data: "1.2.3.4" }] };

    const result = await resolver.resolve4("example.com");

    expect(result).toEqual(["1.2.3.4"]);
    expect(fetchCalls[0].url.startsWith(customEndpoint)).toBe(true);
  });

  it("resolve dispatches to the correct record type", async () => {
    const resolver = new Resolver();
    dohResponse = { Answer: [{ data: "1.2.3.4" }] };

    const result = await resolver.resolve("example.com");

    expect(result).toEqual(["1.2.3.4"]);
    expect(fetchCalls[0].url).toContain("type=A");
  });
});
