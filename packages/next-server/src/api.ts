/** Minimal Next.js Pages Router req/res adapter for API routes, modeled on
 * the shape of node http.IncomingMessage/ServerResponse without requiring
 * node builtins in the main thread. */

export interface NextApiRequestMock {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly query: Record<string, string | string[]>;
  readonly cookies: Record<string, string>;
  readonly body: unknown;
}

export interface NextApiResponseMock {
  status(code: number): NextApiResponseMock;
  json(payload: unknown): void;
  send(body: unknown): void;
  text(body: string): void;
  redirect(statusOrUrl: number | string, url?: string): void;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
  setStatus?(code: number): void;
}

export interface ApiExecutionResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export const parseCookies = (cookieHeader: string): Record<string, string> => {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name && rest.length > 0) {
      cookies[name] = decodeURIComponent(rest.join("="));
    }
  }
  return cookies;
};

const normalizeHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
};

export interface RunApiRouteOptions {
  readonly request: Request;
  readonly pathname: string;
  readonly params: Record<string, string | string[]>;
  readonly handler: unknown;
}

/** Execute a Pages Router API handler. Supports both the classic
 * `(req, res) => void` style and handlers returning a `Response`/payload
 * directly. */
export const runApiRoute = async (options: RunApiRouteOptions): Promise<ApiExecutionResult> => {
  const { request, pathname, params, handler } = options;
  if (typeof handler !== "function") {
    return { status: 500, headers: {}, body: "API route has no default handler" };
  }

  const headers = normalizeHeaders(request.headers);
  const url = new URL(request.url);
  const bodyText = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
  let parsedBody: unknown = bodyText;
  if (bodyText) {
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      parsedBody = bodyText;
    }
  }

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const req: NextApiRequestMock & { query: Record<string, string | string[]> } = {
    method: request.method,
    url: pathname,
    headers,
    query: { ...query, ...params },
    cookies: parseCookies(headers.cookie ?? ""),
    body: parsedBody,
  };

  let status = 200;
  const resHeaders: Record<string, string> = {};
  let body = "";
  let ended = false;

  const finish = (payload: unknown, contentType?: string) => {
    if (ended) return;
    ended = true;
    if (contentType && !resHeaders["content-type"]) {
      resHeaders["content-type"] = contentType;
    }
    if (payload === undefined || payload === null) {
      body = "";
    } else if (typeof payload === "string") {
      body = payload;
    } else {
      body = JSON.stringify(payload);
      if (!resHeaders["content-type"]) resHeaders["content-type"] = "application/json";
    }
  };

  const res: NextApiResponseMock = {
    status(code: number) {
      status = code;
      return this;
    },
    setStatus(code: number) {
      status = code;
    },
    json(payload: unknown) {
      finish(payload, "application/json");
    },
    send(payload: unknown) {
      finish(payload);
    },
    text(payload: string) {
      finish(payload, "text/plain");
    },
    redirect(statusOrUrl: number | string, maybeUrl?: string) {
      if (typeof statusOrUrl === "number") {
        status = statusOrUrl;
        if (maybeUrl) resHeaders.location = maybeUrl;
      } else {
        status = 307;
        resHeaders.location = statusOrUrl;
      }
      ended = true;
    },
    setHeader(name: string, value: string) {
      resHeaders[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return resHeaders[name.toLowerCase()];
    },
  };

  const returned = await (handler as (rq: unknown, rs: unknown) => unknown)(req, res);

  if (!ended) {
    if (returned instanceof Response) {
      returned.headers.forEach((value, key) => {
        resHeaders[key.toLowerCase()] = value;
      });
      return {
        status: returned.status,
        headers: resHeaders,
        body: await returned.text(),
      };
    }
    finish(returned);
  }

  return { status, headers: resHeaders, body };
};
