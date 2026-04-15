// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import events from "unenv/runtime/node/events";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/events";

export const createEventsShim = (): typeof events => {
  return events;
};

export default createEventsShim();
