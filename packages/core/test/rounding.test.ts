import { describe, expect, it } from "vitest";
import { stepDecimals, toStep } from "../src/index.js";

describe("rounding to Strike's steps", () => {
  it("reads decimals from the step, ignoring trailing zeros", () => {
    expect(stepDecimals("0.00010")).toBe(4);
    expect(stepDecimals("0.01")).toBe(2);
    expect(stepDecimals("1")).toBe(0);
  });
  it("rounds prices down to the tick without float noise", () => {
    expect(toStep(2380.2899, "0.01", "down")).toBe("2380.28");
    expect(toStep(0.3, "0.1", "down")).toBe("0.3");
    expect(toStep(0.21629528, "0.00010", "down")).toBe("0.2162");
  });
  it("rounds sizes up to the step when a minimum must be met", () => {
    expect(toStep(0.00252, "0.001", "up")).toBe("0.003");
    expect(toStep(0.003, "0.001", "up")).toBe("0.003");
    expect(toStep(23.1, "1", "up")).toBe("24");
  });
  it("refuses a zero step", () => {
    expect(() => toStep(1, "0", "down")).toThrow(RangeError);
  });
});
