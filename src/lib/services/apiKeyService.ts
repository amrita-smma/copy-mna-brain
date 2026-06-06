import { randomBytes } from 'crypto';
import type { ApiKeyRepository, ApiKeyRow } from '@/lib/repositories';
import { hashPassword, verifyPassword } from './password';

/** Scope required to call the external chat API. */
export const CHAT_WRITE_SCOPE = 'chat:write';

/** Human-readable token prefix so leaked keys are easy to identify in logs/scanners. */
const TOKEN_PREFIX = 'mna_';
/** Length of the lookup prefix stored in plaintext (non-secret). */
const LOOKUP_PREFIX_LEN = 8;
/** Bytes of entropy in the secret portion of the token. */
const SECRET_BYTES = 24;

export class InvalidApiKeyError extends Error {
  constructor() {
    super('Invalid or revoked API key');
    this.name = 'InvalidApiKeyError';
  }
}

export class InsufficientScopeError extends Error {
  constructor(scope: string) {
    super(`API key is missing the required scope: ${scope}`);
    this.name = 'InsufficientScopeError';
  }
}

export class ApiKeyNotFoundError extends Error {
  constructor(id: string) {
    super(`API key ${id} not found`);
    this.name = 'ApiKeyNotFoundError';
  }
}

/** The authenticated machine principal resolved from a valid API key. */
export interface ApiKeyPrincipal {
  id: string;
  name: string;
  scopes: string[];
}

/**
 * Safe-to-expose representation of a key for management endpoints. Deliberately
 * omits `key_hash` — the secret never leaves the issuing call.
 */
export interface ApiKeyView {
  id: string;
  name: string;
  scopes: string[];
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface IssuedApiKey {
  /** The raw token — returned exactly once, never persisted. */
  token: string;
  key: ApiKeyView;
}

export class ApiKeyService {
  constructor(private readonly repo: ApiKeyRepository) {}

  /**
   * Mint a new API key. Returns the raw token (shown to the caller once) and
   * the stored record. Only a scrypt hash + non-secret lookup prefix are
   * persisted — the raw token cannot be recovered afterwards.
   */
  async issue(opts: { name: string; scopes?: string[] }): Promise<IssuedApiKey> {
    const secret = randomBytes(SECRET_BYTES).toString('hex');
    const token = `${TOKEN_PREFIX}${secret}`;
    const keyPrefix = secret.slice(0, LOOKUP_PREFIX_LEN);
    const keyHash = await hashPassword(token);
    const scopes = opts.scopes ?? [CHAT_WRITE_SCOPE];

    const row = await this.repo.create({
      name: opts.name,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      scopes,
    });

    return { token, key: this.toView(row) };
  }

  /** List all keys (metadata only — no hashes, no tokens). */
  async list(): Promise<ApiKeyView[]> {
    const rows = await this.repo.list();
    return rows.map((r) => this.toView(r));
  }

  /** Fetch a single key's metadata, or throw if it does not exist. */
  async get(id: string): Promise<ApiKeyView> {
    const row = await this.repo.getById(id);
    if (!row) throw new ApiKeyNotFoundError(id);
    return this.toView(row);
  }

  /** Update a key's name and/or scopes. Throws if the key does not exist. */
  async update(
    id: string,
    fields: { name?: string; scopes?: string[] },
  ): Promise<ApiKeyView> {
    const patch: { name?: string; scopes?: string[] } = {};
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.scopes !== undefined) patch.scopes = fields.scopes;
    const row = await this.repo.update(id, patch);
    if (!row) throw new ApiKeyNotFoundError(id);
    return this.toView(row);
  }

  /**
   * Verify a raw bearer token. Resolves to the authenticated principal or
   * throws InvalidApiKeyError / InsufficientScopeError. On success the key's
   * last_used_at is refreshed (best-effort).
   */
  async verify(rawToken: string, requiredScope?: string): Promise<ApiKeyPrincipal> {
    if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) {
      throw new InvalidApiKeyError();
    }
    const secret = rawToken.slice(TOKEN_PREFIX.length);
    const keyPrefix = secret.slice(0, LOOKUP_PREFIX_LEN);

    const candidates = await this.repo.findActiveByPrefix(keyPrefix);

    let matched: ApiKeyRow | null = null;
    for (const candidate of candidates) {
      if (await verifyPassword(rawToken, candidate.key_hash)) {
        matched = candidate;
        break;
      }
    }
    if (!matched) {
      throw new InvalidApiKeyError();
    }

    if (requiredScope && !(matched.scopes ?? []).includes(requiredScope)) {
      throw new InsufficientScopeError(requiredScope);
    }

    // Best-effort usage timestamp; never block auth on it.
    await this.repo.touchLastUsed(matched.id).catch(() => undefined);

    return this.toPrincipal(matched);
  }

  /** Revoke a key (soft delete via revoked_at). Throws if it does not exist. */
  async revoke(id: string): Promise<ApiKeyView> {
    const row = await this.repo.revoke(id);
    if (!row) throw new ApiKeyNotFoundError(id);
    return this.toView(row);
  }

  private toPrincipal(row: ApiKeyRow): ApiKeyPrincipal {
    return { id: row.id, name: row.name, scopes: row.scopes ?? [] };
  }

  private toView(row: ApiKeyRow): ApiKeyView {
    return {
      id: row.id,
      name: row.name,
      scopes: row.scopes ?? [],
      key_prefix: row.key_prefix,
      last_used_at: row.last_used_at ?? null,
      revoked_at: row.revoked_at ?? null,
      created_at: row.created_at,
    };
  }
}
