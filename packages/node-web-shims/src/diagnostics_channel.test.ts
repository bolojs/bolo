import { describe, expect, it } from "vitest";
import dc, {
  Channel,
  channel,
  hasSubscribers,
  tracingChannel,
  unsubscribe,
} from "./diagnostics_channel.js";

describe("node:diagnostics_channel shim", () => {
  it("implements object-channel pub/sub (test-diagnostics-channel-object-channel-pub-sub)", () => {
    const input = { foo: "bar" };

    expect(hasSubscribers("test-pub-sub")).toBe(false);

    const ch = channel("test-pub-sub");
    expect(ch).toBeInstanceOf(Channel);
    expect(ch.hasSubscribers).toBe(false);

    const subscriber = (message: unknown, name: string | symbol) => {
      expect(name).toBe(ch.name);
      expect(message).toEqual(input);
    };
    ch.subscribe(subscriber);
    expect(ch.hasSubscribers).toBe(true);
    expect(ch).toBeInstanceOf(Channel);

    ch.publish(input);

    expect(ch.unsubscribe(subscriber)).toBe(true);
    expect(ch.hasSubscribers).toBe(false);
    expect(ch.unsubscribe(subscriber)).toBe(false);

    expect(() => ch.subscribe(null as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("channel() caches by name and module-level unsubscribe works", () => {
    const a = channel("dc-cache-test");
    expect(channel("dc-cache-test")).toBe(a);
    const fn = (): void => {};
    dc.subscribe("dc-cache-test-2", fn);
    expect(hasSubscribers("dc-cache-test-2")).toBe(true);
    expect(unsubscribe("dc-cache-test-2", fn)).toBe(true);
    expect(hasSubscribers("dc-cache-test-2")).toBe(false);
  });

  it("publish snapshots subscribers (mid-publish subscribe is not called)", () => {
    const ch = channel("dc-snapshot-test");
    const late = (): void => {
      throw new Error("must not be called");
    };
    let firstCalls = 0;
    ch.subscribe(() => {
      firstCalls++;
      ch.subscribe(late);
    });
    ch.publish({});
    expect(firstCalls).toBe(1);
    ch.unsubscribe(late);
  });

  it("tracingChannel exposes start/end sub-channels", () => {
    const tc = tracingChannel("dc-trace-test");
    const seen: string[] = [];
    tc.subscribe({
      start: () => seen.push("start"),
      end: () => seen.push("end"),
    });
    const result = tc.traceSync(() => 42);
    expect(result).toBe(42);
    expect(seen).toEqual(["start", "end"]);
  });
});
