/** Decimal places a step such as "0.00010" or "1" allows (trailing zeros carry no precision). */
export function stepDecimals(step: string): number {
  const i = step.indexOf(".");
  return i < 0 ? 0 : step.slice(i + 1).replace(/0+$/, "").length;
}

/**
 * Rounds a value to a whole number of steps and returns the decimal string Strike expects.
 * Works in integer step units so results never carry float noise such as 0.30000000000000004.
 */
export function toStep(value: number, step: string, mode: "down" | "up"): string {
  const d = stepDecimals(step);
  const scale = 10 ** d;
  const stepUnits = Math.round(Number(step) * scale);
  if (!(stepUnits > 0)) throw new RangeError(`step must be positive: ${step}`);
  const units = (value * scale) / stepUnits;
  const n = mode === "down" ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9);
  return ((n * stepUnits) / scale).toFixed(d);
}
