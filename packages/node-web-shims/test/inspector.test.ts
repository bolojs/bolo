import { describe, it, expect } from "vitest";
import inspector, {
  open,
  close,
  url,
  waitForDebugger,
  Session,
} from "../src/inspector.ts";

describe("node-web-shims: inspector", () => {
  it("open(99999) throws ERR_OUT_OF_RANGE with node's exact message (test-inspector-open-port-integer-overflow)", () => {
    expect(() => open(99999)).toThrowError(
      expect.objectContaining({
        name: "RangeError",
        code: "ERR_OUT_OF_RANGE",
        message: 'The value of "port" is out of range. It must be >= 0 && <= 65535. Received 99999',
      }),
    );
    expect(() => open(-1)).toThrowError(
      expect.objectContaining({
        code: "ERR_OUT_OF_RANGE",
        message: 'The value of "port" is out of range. It must be >= 0 && <= 65535. Received -1',
      }),
    );
    expect(() => open(1.5)).toThrowError(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
  });

  it("open with a valid port fails honestly with ERR_NOT_IMPLEMENTED (no debug port in the browser)", () => {
    expect(() => open(0, undefined, false)).toThrowError(
      expect.objectContaining({ code: "ERR_NOT_IMPLEMENTED" }),
    );
    expect(() => open()).toThrowError(
      expect.objectContaining({ code: "ERR_NOT_IMPLEMENTED" }),
    );
  });

  it("url() is undefined while not activated; close() is a safe no-op (test-inspector-stops-no-file)", () => {
    expect(url()).toBeUndefined();
    expect(() => close()).not.toThrow();
    expect(url()).toBeUndefined();
  });

  it("waitForDebugger is a no-op", () => {
    expect(waitForDebugger()).toBeUndefined();
  });

  it("Session.connect() twice throws ERR_INSPECTOR_ALREADY_CONNECTED", () => {
    const session = new Session();
    session.connect();
    expect(() => session.connect()).toThrowError(
      expect.objectContaining({
        code: "ERR_INSPECTOR_ALREADY_CONNECTED",
        message: "Session is already connected",
      }),
    );
  });

  it("Session.disconnect() emits disconnect", () => {
    const session = new Session();
    let disconnected = false;
    session.on("disconnect", () => {
      disconnected = true;
    });
    session.connect();
    session.disconnect();
    expect(disconnected).toBe(true);
  });

  it("Session.post validates the method synchronously (ERR_INVALID_ARG_TYPE)", () => {
    const session = new Session();
    expect(() =>
      session.post(42 as unknown as string),
    ).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: 'The "method" argument must be of type string. Received type number (42)',
      }),
    );
  });

  it("Session.post invokes the callback asynchronously with ERR_NOT_IMPLEMENTED", async () => {
    const session = new Session();
    session.connect();
    let sync = true;
    const error = await new Promise<Error | null>((resolve) => {
      session.post("Runtime.enable", (err) => resolve(err));
      sync = false;
    });
    expect(sync).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect((error as unknown as { code?: string }).code).toBe("ERR_NOT_IMPLEMENTED");
  });

  it("default export exposes the module surface", () => {
    expect(inspector.open).toBe(open);
    expect(inspector.close).toBe(close);
    expect(inspector.url).toBe(url);
    expect(inspector.waitForDebugger).toBe(waitForDebugger);
    expect(inspector.Session).toBe(Session);
  });
});
