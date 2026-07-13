const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true if the value is a canonical UUID string. Used by routes that
 * accept either an existing entity id or a free-text name in the same field:
 * a hyphen alone is not a reliable discriminator (names like "Star-Tech"
 * contain hyphens too), so we match the full UUID shape instead.
 */
export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}
