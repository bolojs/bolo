import querystring from "unenv/node/querystring";

export * from "unenv/node/querystring";

type ParseFn = (
  str: string,
  sep?: string,
  eq?: string,
  options?: { decodeURIComponent?: (s: string) => string; maxKeys?: number },
) => Record<string, unknown>;

interface QuerystringModule {
  parse: ParseFn;
  decode: ParseFn;
  unescape?: (str: string) => string;
  escape?: (str: string) => string;
  stringify?: unknown;
  encode?: unknown;
  unescapeBuffer?: unknown;
  [key: string]: unknown;
}

const qs = querystring as unknown as QuerystringModule;
const origParse = qs.parse;
const origUnescape = qs.unescape;

const wrappedParse: ParseFn = (str, sep, eq, options) => {
  const customUnescape =
    querystringShim.unescape !== origUnescape ? querystringShim.unescape : undefined;
  const decodeURIComponent = options?.decodeURIComponent ?? customUnescape;
  if (decodeURIComponent) {
    return origParse(str, sep, eq, {
      ...options,
      decodeURIComponent,
    });
  }
  return origParse(str, sep, eq, options);
};

const querystringShim: QuerystringModule = {
  ...qs,
  parse: wrappedParse,
  decode: wrappedParse,
};

export const parse = wrappedParse;
export const decode = wrappedParse;

export const createQuerystringShim = (): QuerystringModule => {
  return querystringShim;
};

export default querystringShim;
