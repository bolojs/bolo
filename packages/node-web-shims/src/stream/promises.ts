import { promises } from "../stream.js";

// `node:stream/promises` — promise-returning pipeline/finished facades.
export const { pipeline, finished } = promises;

export default promises;
