export { getLogger } from "@logtape/logtape";
export type { LogLevel, LogRecord, Sink } from "@logtape/logtape";
export { configureBoloLogging } from "./node.js";
export type { ConfigureBoloLoggingOptions } from "./node.js";
export {
  hintFor,
  attachHint,
  enrichMessage,
  type BoloError,
  type BoloErrorKind,
  type BoloErrorSource,
} from "./error-hints.js";
