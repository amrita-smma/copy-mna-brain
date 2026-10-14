/**
 * treg.to client — person enrichment and phone lookup.
 *
 * treg (https://treg.to/llms.txt) fronts a catalog of data vendors behind one
 * token. We use two of its routed endpoints. `treg.people.enrich`
 * which takes whatever identifiers we hold for a person (work email, LinkedIn
 * URL, or name + company domain), runs the cheapest provider that accepts
 * them, falls through to the next on a miss, and answers in one normalised
 * shape regardless of which vendor served:
 *
 *   { output: { full_name, title, company: {...}, linkedin_url, ... },
 *     raw: <the vendor's own body>,
 *     _treg: { served_by, provider, outcome, tried, charged_micro } }
 *
 * A miss is a 200 with `output.full_name == null`, not an error.
 *
 * `people.enrich` returns no phone number — that is a separate capability,
 * `treg.people.phone.find`, which takes the same identifiers and answers
 * `{ output: { phone, ... } }` (a miss is `output.phone == null`). We send
 * `X-Treg-Route-Verify: true` on it so treg checks a hit with an HLR network
 * lookup in the same call: `_treg.verification.verdict` is `live`, `dead` or
 * `unknown`. A live line is still not proof the number is this person's.
 *
 * Spend is capped per call with `X-Treg-Route-Max-Cost` — the waterfall bills
 * every provider it tries that charges for a miss, and without the header
 * treg's default ceiling is $1 a call.
 */

export const TREG_PEOPLE_ENRICH_URL = 'https://treg.to/call/treg.people.enrich';
export const TREG_PEOPLE_PHONE_FIND_URL = 'https://treg.to/call/treg.people.phone.find';

/** Per-call ceiling across the whole provider waterfall, in USD. */
export const TREG_MAX_COST_USD = '0.10';

/** treg's routed tools poll async children for up to 60s; leave headroom. */
const TREG_TIMEOUT_MS = 75_000;

export class TregError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TregError';
  }
}

/** Identifiers treg matches on. Send everything known — treg derives the rest. */
export interface TregPersonQuery {
  email?: string;
  linkedin_url?: string;
  full_name?: string;
  domain?: string;
}

export interface TregPersonCompany {
  name?: string | null;
  linkedin_url?: string | null;
  website_url?: string | null;
  industry?: string | null;
  employee_count?: number | null;
  employee_range?: string | null;
}

/**
 * The normalised `output`. Only `full_name` is guaranteed on a hit; every
 * other field depends on the vendor that served, so all are optional and the
 * index signature keeps vendor extras (seniority, location, …) readable.
 */
export interface TregPerson {
  full_name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  seniority?: string | null;
  department?: string | null;
  headline?: string | null;
  summary?: string | null;
  location?: string | null;
  country?: string | null;
  company?: TregPersonCompany | null;
  company_domain?: string | null;
  linkedin_url?: string | null;
  [key: string]: unknown;
}

export interface TregPersonResult {
  /** `null` on a miss — no provider found this person. */
  person: TregPerson | null;
  /** Catalog id of the child endpoint that answered, e.g. `moltsets.people.enrich.name`. */
  servedBy: string | null;
  /** `X-Treg-Call-Id` — treg support and `GET /calls/{id}` key on it. */
  callId: string | null;
  /** What the call actually cost, in micro-USD (`X-Treg-Cost-Micro`). */
  costMicro: number;
}

/** HLR verdict on a found number; `null` when treg ran no check. */
export type TregPhoneVerdict = 'live' | 'dead' | 'unknown';

export interface TregPhoneResult {
  /** `null` on a miss — no provider found a number. */
  phone: string | null;
  /** HLR line check; `null` when no check ran (e.g. the number was not international). */
  verdict: TregPhoneVerdict | null;
  servedBy: string | null;
  callId: string | null;
  costMicro: number;
}

interface TregRoutedBody<T> {
  output?: T | null;
  detail?: unknown;
  _treg?: {
    served_by?: string | null;
    verification?: { verdict?: string | null; checked?: boolean } | null;
  };
}

interface TregPhoneOutput {
  phone?: string | null;
  [key: string]: unknown;
}

export function getTregApiKey(): string | undefined {
  return process.env.TREG_API_KEY?.trim() || undefined;
}

/** Drop empty identifiers so treg only matches on what we actually hold. */
function compactQuery(query: TregPersonQuery): TregPersonQuery {
  return Object.fromEntries(
    Object.entries(query).filter(
      ([, v]) => typeof v === 'string' && v.trim().length > 0,
    ),
  ) as TregPersonQuery;
}

interface RoutedCall<T> {
  json: TregRoutedBody<T>;
  servedBy: string | null;
  callId: string | null;
  costMicro: number;
}

/**
 * POST a routed `treg.*` endpoint with the per-call spend cap. Throws
 * `TregError` on a missing key, empty identifiers, a non-2xx (treg's JSON
 * `detail` folded into the message) or a network failure.
 */
async function callRouted<T>(
  url: string,
  label: string,
  query: TregPersonQuery,
  fetchImpl: typeof fetch,
  extraHeaders: Record<string, string> = {},
): Promise<RoutedCall<T>> {
  const apiKey = getTregApiKey();
  if (!apiKey) throw new TregError('TREG_API_KEY is not set');

  const body = compactQuery(query);
  if (Object.keys(body).length === 0) {
    throw new TregError('No identifiers to enrich on');
  }

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Treg-Token': apiKey,
      'X-Treg-Route-Max-Cost': TREG_MAX_COST_USD,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TREG_TIMEOUT_MS),
  });

  const text = await res.text();
  let json: TregRoutedBody<T> = {};
  try {
    json = text ? (JSON.parse(text) as TregRoutedBody<T>) : {};
  } catch {
    // Non-JSON body — only possible on an upstream/edge error; handled below.
  }

  if (!res.ok) {
    const detail =
      json.detail === undefined
        ? text.slice(0, 300)
        : typeof json.detail === 'string'
          ? json.detail
          : JSON.stringify(json.detail).slice(0, 300);
    throw new TregError(`${label} returned ${res.status}: ${detail}`, res.status);
  }

  return {
    json,
    servedBy: res.headers.get('x-treg-served-by') ?? json._treg?.served_by ?? null,
    callId: res.headers.get('x-treg-call-id'),
    costMicro: Number(res.headers.get('x-treg-cost-micro') ?? 0) || 0,
  };
}

/**
 * Enrich one person via `treg.people.enrich`.
 *
 * Throws `TregError` (see `callRouted`); returns `person: null` on a clean miss.
 */
export async function enrichPerson(
  query: TregPersonQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<TregPersonResult> {
  const { json, ...meta } = await callRouted<TregPerson>(
    TREG_PEOPLE_ENRICH_URL,
    'treg.people.enrich',
    query,
    fetchImpl,
  );
  const person = json.output?.full_name ? json.output : null;
  return { person, ...meta };
}

const PHONE_VERDICTS = new Set<string>(['live', 'dead', 'unknown']);

/**
 * Find one person's phone number via `treg.people.phone.find`, with treg's
 * HLR line check on a hit.
 *
 * Throws `TregError` (see `callRouted`); returns `phone: null` on a clean miss.
 */
export async function findPhone(
  query: TregPersonQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<TregPhoneResult> {
  const { json, ...meta } = await callRouted<TregPhoneOutput>(
    TREG_PEOPLE_PHONE_FIND_URL,
    'treg.people.phone.find',
    query,
    fetchImpl,
    { 'X-Treg-Route-Verify': 'true' },
  );
  const raw = json.output?.phone;
  const phone = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  const verdict = json._treg?.verification?.verdict;
  return {
    phone,
    verdict:
      phone && verdict && PHONE_VERDICTS.has(verdict) ? (verdict as TregPhoneVerdict) : null,
    ...meta,
  };
}
