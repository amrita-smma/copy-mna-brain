/**
 * Computes a unique name for a duplicated insight.
 * Candidates in order: "{base} (copy)", "{base} (copy 2)", "{base} (copy 3)", ...
 * The first candidate not in existingNames (exact match after trim) wins.
 * Truncates base so that base + suffix never exceeds maxLength.
 */
export function duplicateInsightName(
  original: string,
  existingNames: Iterable<string>,
  maxLength: number,
): string {
  const existingSet = new Set<string>();
  for (const name of existingNames) {
    if (typeof name === 'string') {
      existingSet.add(name.trim());
    }
  }

  const trimmedOriginal = original.trim();

  let counter = 1;
  while (true) {
    const suffix = counter === 1 ? ' (copy)' : ` (copy ${counter})`;
    const allowedBaseLength = Math.max(0, maxLength - suffix.length);
    const base = trimmedOriginal.slice(0, allowedBaseLength).trimEnd();
    const candidate = `${base}${suffix}`;
    if (!existingSet.has(candidate.trim())) {
      return candidate;
    }
    counter++;
  }
}
