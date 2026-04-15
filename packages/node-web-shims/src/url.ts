// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import url from "unenv/runtime/node/url";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/url";

export const createUrlShim = (): typeof url => {
  return url;
};

export default createUrlShim();
