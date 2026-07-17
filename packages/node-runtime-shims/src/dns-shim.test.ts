import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDnsShim } from "./dns-shim.js";

describe("createDnsShim", () => {
  let fetchCalls: { url: string; init: RequestInit | undefined }[] = [];
  let dohResponse: { Answer?: Array<{ data: string }> } = { Answer: [] };

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
