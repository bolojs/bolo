import { describe, it, expect } from "vitest";
// @ts-expect-error plain-JS module, no type declarations
import {
  isValidated,
  isHarnessSourced,
  rowStatus,
  PENDING_STATUS,
} from "../../apps/site/compat/scripts/status.js";

describe("compat site validation flag", () => {
  it("is validated only when both harness sources say true", () => {
    expect(isValidated({ validated: true }, { validated: true })).toBe(true);
    expect(isValidated({ validated: false }, { validated: true })).toBe(false);
    expect(isValidated({ validated: true }, { validated: false })).toBe(false);
    expect(isValidated({}, {})).toBe(false);
    expect(isValidated({ validated: "yes" }, { validated: true })).toBe(false);
  });

  it("tool rows are not harness-sourced", () => {
    expect(isHarnessSourced({ tool: {}, pkg: undefined, mod: undefined })).toBe(false);
    expect(isHarnessSourced({ tool: undefined, pkg: {}, mod: undefined })).toBe(true);
    expect(isHarnessSourced({ tool: undefined, pkg: undefined, mod: {} })).toBe(true);
    expect(isHarnessSourced({ tool: undefined, pkg: undefined, mod: undefined })).toBe(false);
  });

  it("unvalidated runs demote harness rows to pending, tools keep status", () => {
    expect(rowStatus(false, { pkg: {} }, "pass")).toBe(PENDING_STATUS);
    expect(rowStatus(false, { mod: {} }, "fail")).toBe(PENDING_STATUS);
    expect(rowStatus(false, { tool: {} }, "pass")).toBe("pass");
    expect(rowStatus(false, {}, "unknown")).toBe("unknown");
    expect(rowStatus(true, { pkg: {} }, "pass")).toBe("pass");
  });
});
