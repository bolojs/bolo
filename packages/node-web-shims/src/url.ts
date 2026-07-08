import url from "unenv/node/url";
export * from "unenv/node/url";

export const createUrlShim = (): typeof url => {
  return url;
};

export default createUrlShim();
