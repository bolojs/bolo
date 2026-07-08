import events from "unenv/node/events";
export * from "unenv/node/events";

export const createEventsShim = (): typeof events => {
  return events;
};

export default createEventsShim();
