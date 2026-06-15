/**
 * Normalize the free-text `% Stake` field (target ownership percentage being
 * pursued) into a canonical "NN%" string.
 *
 * Accepts numbers with or without a trailing `%`, optional decimals, and
 * thousands-style commas. Rejects non-numeric input or values outside 0–100.
 * Empty input clears the field (→ null).
 */
export type NormalizeStakeResult =
  | { value: string | null }
  | { error: string };

export function normalizeStake(input: string): NormalizeStakeResult {
  const trimmed = input.trim();
  if (trimmed === "") return { value: null };

  const cleaned = trimmed.replace(/%/g, "").replace(/,/g, "").trim();
  const n = Number(cleaned);
  if (cleaned === "" || !Number.isFinite(n)) {
    return { error: "% Stake must be a percentage, e.g. 51%" };
  }
  if (n < 0 || n > 100) {
    return { error: "% Stake must be between 0% and 100%" };
  }
  // Round to 2 dp and drop trailing zeros: 51 → "51%", 51.50 → "51.5%".
  return { value: `${Number(n.toFixed(2))}%` };
}
