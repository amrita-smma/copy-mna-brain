'use client';

import { useState, useEffect, useCallback } from 'react';

interface UseLocalStorageOptions<T> {
  /**
   * Validates a successfully-parsed value before it is accepted. Return `false`
   * to discard the stored value and fall back to `initialValue`. Defaults to a
   * shallow type check against `initialValue` (matching `typeof` and array-ness),
   * which guards against stale/corrupt entries of the wrong shape — e.g. a
   * boolean stored under a numeric key — that are valid JSON but break rendering.
   */
  validate?: (value: unknown) => boolean;
}

function defaultValidate<T>(value: unknown, initialValue: T): boolean {
  // `null` initial values opt out of type checking (any shape is acceptable).
  if (initialValue === null) return true;
  if (value === null || value === undefined) return false;
  if (Array.isArray(initialValue)) return Array.isArray(value);
  if (Array.isArray(value)) return false;
  return typeof value === typeof initialValue;
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  options: UseLocalStorageOptions<T> = {},
): [T, (value: T | ((prev: T) => T)) => void] {
  const { validate } = options;
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initialValue;
    try {
      const item = window.localStorage.getItem(key);
      if (item === null) return initialValue;
      const parsed = JSON.parse(item) as unknown;
      const isValid = validate ? validate(parsed) : defaultValidate(parsed, initialValue);
      return isValid ? (parsed as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(storedValue));
    } catch {
      // ignore write errors (private browsing, storage full)
    }
  }, [key, storedValue]);

  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    setStoredValue((prev) => {
      const next = typeof value === 'function' ? (value as (prev: T) => T)(prev) : value;
      return next;
    });
  }, []);

  return [storedValue, setValue];
}
