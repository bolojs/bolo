// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/events/index.mjs";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import events from "unenv/runtime/node/events/index.mjs";

export const createEventsShim = (): typeof events => {
  return events;
};

export default createEventsShim();
