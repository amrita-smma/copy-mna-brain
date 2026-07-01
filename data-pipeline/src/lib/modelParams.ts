/**
 * Whether an Anthropic model accepts explicit sampling parameters
 * (`temperature`, `top_p`, `top_k`).
 *
 * Newer model families (Claude Sonnet 5+, Opus 4.7+, Fable 5) REJECT any
 * explicit sampling params and return a 400
 * ("`temperature` is deprecated for this model."). Older models (Haiku,
 * Sonnet ≤4.x, Opus ≤4.6) still accept them, so we keep passing
 * `temperature: 0` there for determinism.
 *
 * Callers should gate the `temperature` field on this helper and omit it
 * entirely for models that return false.
 */
export function modelSupportsTemperature(model: string): boolean {
  // Anchored patterns for the known no-temperature families. Matching from the
  // start of the string avoids false positives, while the trailing `(-|$)`
  // tolerates dated suffixes (e.g. `claude-sonnet-5-20260101`).
  const NO_TEMPERATURE_PATTERNS = [
    /^claude-sonnet-5(-|$)/,
    /^claude-opus-4-7(-|$)/,
    /^claude-opus-4-8(-|$)/,
    /^claude-fable-5(-|$)/,
  ];
  return !NO_TEMPERATURE_PATTERNS.some((re) => re.test(model));
}
