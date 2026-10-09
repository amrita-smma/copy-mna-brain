/**
 * Whether an Anthropic model accepts explicit sampling parameters
 * (`temperature`, `top_p`, `top_k`).
 *
 * Every current family now REJECTS them with a 400 ("`temperature` is
 * deprecated for this model."). Haiku crossed over at 5.5: Haiku 4.5 and
 * earlier still accept them, so we keep passing `temperature: 0` there for
 * determinism, while Haiku 5.5 only tolerates the defaults (`temperature: 1`,
 * `top_p: 0.99`) and 400s on anything else — including `top_k` at any value.
 *
 * Callers should gate the `temperature` field on this helper and omit it
 * entirely for models that return false.
 */
export function modelSupportsTemperature(model: string): boolean {
  // Anchored patterns for the known no-temperature families. Matching from the
  // start of the string avoids false positives, while the trailing `(-|$)`
  // covers both point releases (`claude-opus-5` → `claude-opus-5-5`) and dated
  // suffixes (e.g. `claude-sonnet-5-20260101`).
  const NO_TEMPERATURE_PATTERNS = [
    /^claude-sonnet-5(-|$)/,
    /^claude-opus-4-7(-|$)/,
    /^claude-opus-4-8(-|$)/,
    /^claude-opus-5(-|$)/,
    /^claude-haiku-5-5(-|$)/,
    /^claude-fable-5(-|$)/,
  ];
  return !NO_TEMPERATURE_PATTERNS.some((re) => re.test(model));
}
