import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { curl } from "./curl.js";

class MockVfs {
  files = new Map<string, string>();
  async writeFile(path: string, content: string | Uint8Array) {
    this.files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
  }
}

const mockResponse = (init: ResponseInit & { body?: string }): Response =>
  new Response(init.body ?? "", init);

describe("curl", () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalVfs: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    originalVfs = (globalThis as unknown as { __vfsBus?: unknown }).__vfsBus;
    (globalThis as unknown as { __vfsBus: MockVfs }).__vfsBus = new MockVfs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { __vfsBus?: unknown }).__vfsBus = originalVfs;
  });

  it("GETs and prints body", async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, statusText: "OK", body: "hello" }));
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const code = await curl(["https://example.com"], output);
    expect(code).toBe(0);
    expect(output.stdout).toHaveBeenCalledWith("hello");
  });

  it("prepends https:// when URL has no protocol", async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    await curl(["example.com"], { stdout: vi.fn(), stderr: vi.fn() });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("honors -X method", async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    await curl(["-X", "PUT", "example.com"], { stdout: vi.fn(), stderr: vi.fn() });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("sends -d body and switches to POST", async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    await curl(["-d", "payload", "example.com"], { stdout: vi.fn(), stderr: vi.fn() });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ method: "POST", body: "payload" }),
    );
  });

  it("sends repeated -H headers", async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    await curl(["-H", "X-Custom: 1", "-H", "Accept: text/plain", "example.com"], {
      stdout: vi.fn(),
      stderr: vi.fn(),
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("X-Custom")).toBe("1");
    expect(headers.get("Accept")).toBe("text/plain");
  });

  it("-I HEAD prints response status and headers", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "text/html" },
        body: "",
      }),
    );
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const code = await curl(["-I", "example.com"], output);
    expect(code).toBe(0);
    const stdout = output.stdout.mock.calls.map((c) => c[0]).join("");
    expect(stdout).toContain("HTTP/1.1 200 OK");
    expect(stdout).toContain("Content-Type: text/html");
  });

  it("-f exits 22 on HTTP >= 400", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ status: 404, statusText: "Not Found", body: "nope" }),
    );
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const code = await curl(["-f", "example.com"], output);
    expect(code).toBe(22);
    expect(output.stdout).not.toHaveBeenCalled();
  });

  it("-o writes body to __vfsBus", async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: "saved" }));
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const code = await curl(["-o", "/out.txt", "example.com"], output);
    expect(code).toBe(0);
    const vfs = (globalThis as unknown as { __vfsBus: MockVfs }).__vfsBus;
    expect(vfs.files.get("/out.txt")).toBe("saved");
  });

  it("errors when -o is used without __vfsBus", async () => {
    (globalThis as unknown as { __vfsBus?: unknown }).__vfsBus = undefined;
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: "saved" }));
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const code = await curl(["-o", "/out.txt", "example.com"], output);
    expect(code).toBe(1);
    expect(output.stderr).toHaveBeenCalledWith(expect.stringContaining("__vfsBus"));
  });

  it("-L passes redirect: follow", async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: "" }));
    await curl(["-L", "example.com"], { stdout: vi.fn(), stderr: vi.fn() });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("follow");
  });

  it("verbose -v prints request and response headers to stderr", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "text/html" },
        body: "",
      }),
    );
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const code = await curl(["-v", "-H", "X-Test: ok", "example.com"], output);
    expect(code).toBe(0);
    const stderr = output.stderr.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toContain("> GET / HTTP/1.1");
    expect(stderr).toContain("> Host: example.com");
    expect(stderr).toContain("> X-Test: ok");
    expect(stderr).toContain("< HTTP/1.1 200 OK");
    expect(stderr).toContain("< Content-Type: text/html");
  });
});
