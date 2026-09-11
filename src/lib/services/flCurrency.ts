import { InvalidCurrencyError } from './flErrors';

/** Cached module-level set of supported ISO 4217 currency codes */
const SUPPORTED_CURRENCIES = new Set(
  Intl.supportedValuesOf('currency').map((c) => c.toUpperCase()),
);

/**
 * Validates that a currency code is a valid ISO 4217 code.
 * Throws InvalidCurrencyError if invalid.
 */
export function validateCurrency(currency: string | null | undefined): string {
  if (!currency || typeof currency !== 'string') {
    throw new InvalidCurrencyError(
      `Currency is required and must be a valid ISO 4217 code. Received: ${currency}`,
    );
  }

  const normalized = currency.trim().toUpperCase();
  if (normalized.length !== 3 || !SUPPORTED_CURRENCIES.has(normalized)) {
    throw new InvalidCurrencyError(
      `Invalid ISO 4217 currency code: "${currency}". Must be one of ${SUPPORTED_CURRENCIES.size} supported codes.`,
    );
  }

  return normalized;
}

export function isValidCurrency(currency: string | null | undefined): boolean {
  if (!currency || typeof currency !== 'string') return false;
  const normalized = currency.trim().toUpperCase();
  return normalized.length === 3 && SUPPORTED_CURRENCIES.has(normalized);
}
