const MICRO_UNITS = 1_000_000n;

/** Parse a non-negative USD decimal string into micro-USDC (6 decimals). */
export function parseUsdToMicros(value: string): bigint {
  const parts = value.split(".");
  const whole = parts[0] ?? "0";
  const fractional = (parts[1] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(whole || "0") * MICRO_UNITS + BigInt(fractional || "0");
}

/** Format micro-USDC back into a trimmed decimal string. */
export function formatMicros(value: bigint): string {
  const whole = value / MICRO_UNITS;
  const fractional = value % MICRO_UNITS;
  if (fractional === 0n) return whole.toString();
  return `${whole.toString()}.${fractional.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

/**
 * Parse a non-negative decimal string into integer base units at `decimals`
 * precision. Defaults to **7** decimals, matching the settlement token used
 * in the demos; pass `decimals` explicitly for a token with a different
 * precision.
 */
export function parseUnits(value: string, decimals = 7): bigint {
  const parts = value.split(".");
  const whole = parts[0] ?? "0";
  const fractional = (parts[1] ?? "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fractional || "0");
}

/** Format integer base units back into a trimmed decimal string at `decimals` precision. */
export function formatUnits(value: bigint, decimals = 7): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fractional = value % base;
  if (fractional === 0n) return whole.toString();
  return `${whole.toString()}.${fractional.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}
