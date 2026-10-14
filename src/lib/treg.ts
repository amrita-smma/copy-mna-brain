/**
 * treg.to client — person enrichment only.
 *
 * treg (https://treg.to/llms.txt) fronts a catalog of data vendors behind one
 * token. We use exactly one endpoint of it: the routed `treg.people.enrich`,
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
 * Spend is capped per call with `X-Treg-Route-Max-Cost` — the waterfall bills
 * every provider it tries that charges for a miss, and without the header
 * treg's default ceiling is $1 a call.
 */

export const TREG_PEOPLE_ENRICH_URL = 'https://treg.to/call/treg.people.enrich';

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

interface TregEnrichBody {
  output?: TregPerson | null;
  detail?: unknown;
  _treg?: { served_by?: string | null };
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

/**
 * Enrich one person via `treg.people.enrich`.
 *
 * Throws `TregError` on a missing key, a non-2xx (treg's own JSON `detail` is
 * folded into the message) or a network failure; returns `person: null` on a
 * clean miss.
 */
export async function enrichPerson(
  query: TregPersonQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<TregPersonResult> {
  const apiKey = getTregApiKey();
  if (!apiKey) throw new TregError('TREG_API_KEY is not set');

  const body = compactQuery(query);
  if (Object.keys(body).length === 0) {
    throw new TregError('No identifiers to enrich on');
  }

  const res = await fetchImpl(TREG_PEOPLE_ENRICH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Treg-Token': apiKey,
      'X-Treg-Route-Max-Cost': TREG_MAX_COST_USD,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TREG_TIMEOUT_MS),
  });

  const text = await res.text();
  let json: TregEnrichBody = {};
  try {
    json = text ? (JSON.parse(text) as TregEnrichBody) : {};
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
    throw new TregError(`treg.people.enrich returned ${res.status}: ${detail}`, res.status);
  }

  const person = json.output?.full_name ? json.output : null;
  return {
    person,
    servedBy: res.headers.get('x-treg-served-by') ?? json._treg?.served_by ?? null,
    callId: res.headers.get('x-treg-call-id'),
    costMicro: Number(res.headers.get('x-treg-cost-micro') ?? 0) || 0,
  };
}
