import { describe, it, expect } from "vitest";
import { parseCookies, runApiRoute } from "./api.js";
import { runGetStaticProps } from "./data.js";

const makeRequest = (method: string, url: string, body?: string) =>
  new Request(`https://sandbox.local${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body,
  });

describe("parseCookies", () => {
  it("parses a cookie header", () => {
    expect(parseCookies("a=1; b=two%20words")).toEqual({ a: "1", b: "two words" });
    expect(parseCookies("")).toEqual({});
  });
});

describe("runApiRoute", () => {
  it("supports the (req, res) handler style", async () => {
    const result = await runApiRoute({
      request: makeRequest("POST", "/api/echo?x=1", '{"a":2}'),
      pathname: "/api/echo",
      params: {},
      handler: (req: any, res: any) => {
        res.status(201);
        res.setHeader("x-custom", "yes");
        res.json({ got: req.body, q: req.query });
      },
    });
    expect(result.status).toBe(201);
    expect(result.headers["x-custom"]).toBe("yes");
    expect(result.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(result.body)).toEqual({ got: { a: 2 }, q: { x: "1" } });
  });

  it("exposes route params on req.query", async () => {
    const result = await runApiRoute({
      request: makeRequest("GET", "/api/items/9"),
      pathname: "/api/items/9",
      params: { id: "9" },
      handler: (req: any, res: any) => res.json({ id: req.query.id }),
    });
    expect(JSON.parse(result.body)).toEqual({ id: "9" });
  });

  it("supports handlers returning a Response", async () => {
    const result = await runApiRoute({
      request: makeRequest("GET", "/api/new-style"),
      pathname: "/api/new-style",
      params: {},
      handler: () => new Response("plain", { status: 202 }),
    });
    expect(result.status).toBe(202);
    expect(result.body).toBe("plain");
  });

  it("supports res.send with strings and objects", async () => {
    const r1 = await runApiRoute({
      request: makeRequest("GET", "/a"),
      pathname: "/a",
      params: {},
      handler: (_req: any, res: any) => res.send("text body"),
    });
    expect(r1.body).toBe("text body");

    const r2 = await runApiRoute({
      request: makeRequest("GET", "/b"),
      pathname: "/b",
      params: {},
      handler: (_req: any, res: any) => res.send({ obj: true }),
    });
    expect(JSON.parse(r2.body)).toEqual({ obj: true });
  });

  it("supports res.redirect", async () => {
    const result = await runApiRoute({
      request: makeRequest("GET", "/old"),
      pathname: "/old",
      params: {},
      handler: (_req: any, res: any) => res.redirect("/new"),
    });
    expect(result.status).toBe(307);
    expect(result.headers.location).toBe("/new");
  });

  it("500s when the handler is missing", async () => {
    const result = await runApiRoute({
      request: makeRequest("GET", "/x"),
      pathname: "/x",
      params: {},
      handler: undefined,
    });
    expect(result.status).toBe(500);
  });
});

describe("runGetStaticProps", () => {
  it("returns empty props when the export is missing", async () => {
    expect(await runGetStaticProps({}, { params: {} })).toEqual({ props: {} });
  });

  it("returns props and revalidate", async () => {
    const result = await runGetStaticProps(
      {
        getStaticProps: async ({ params }: any) => ({
          props: { id: params.id },
          revalidate: 60,
        }),
      },
      { params: { id: "3" } },
    );
    expect(result.props).toEqual({ id: "3" });
    expect(result.revalidate).toBe(60);
  });

  it("rejects results without a props key", async () => {
    await expect(
      runGetStaticProps({ getStaticProps: async () => ({}) }, { params: {} }),
    ).rejects.toThrow(/props/);
  });
});
