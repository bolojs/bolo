import { consumers } from "../stream.js";

// `node:stream/consumers` — consume a Readable (or web ReadableStream) into a
// single value.
export const { arrayBuffer, blob, buffer, bytes, json, text } = consumers;

export default consumers;
