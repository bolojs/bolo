import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHttpShim } from "./http-shim.js";
import type { IncomingMessage } from "./http-shim.js";

describe("http client shim", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

  const collectBody = (res: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      res.on("end", () => {
        resolve(Buffer.concat(chunks).toString());
      });
    });

  it("http.get returns a response with statusCode and a readable body", async () => {
    const shim = createHttpShim();
    fetchMock().mockResolvedValue(
      new Response("hello world", {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const res = await new Promise<IncomingMessage>((resolve) => {
      shim.get("http://example.test/", (response) => resolve(response));
    });

    expect(res.statusCode).toBe(200);
    expect(res.statusMessage).toBe("OK");
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(await collectBody(res)).toBe("hello world");
  });

  it("http.request with method POST forwards body to fetch", async () => {
    const shim = createHttpShim();
    fetchMock().mockResolvedValue(new Response("created", { status: 201 }));

    const res = await new Promise<IncomingMessage>((resolve) => {
      const req = shim.request("http://example.test/", { method: "POST" }, (response) => {
        resolve(response);
      });
      req.write("payload");
      req.end();
    });

    expect(res.statusCode).toBe(201);

    const [url, init] = fetchMock().mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("http://example.test/");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe("payload");
  });

  it("ClientRequest.destroy aborts the underlying fetch", async () => {
    const shim = createHttpShim();
    fetchMock().mockImplementation(() => new Promise(() => {}));

    const req = shim.request("http://example.test/", () => {});
    req.end();
    req.destroy();

    expect(fetchMock()).toHaveBeenCalledOnce();
    const init = fetchMock().mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });

  it("get without callback still returns a ClientRequest and ends", () => {
    const shim = createHttpShim();
    fetchMock().mockResolvedValue(new Response("ok", { status: 200 }));

    const req = shim.get("http://example.test/");
    expect(req).toBeDefined();
    expect(req.method).toBe("GET");
    expect(fetchMock()).toHaveBeenCalledOnce();
  });
});
