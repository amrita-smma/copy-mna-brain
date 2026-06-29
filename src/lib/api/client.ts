async function parseJsonSafe(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response (${res.status})`);
  }
}

const SHARED_SECRET = process.env.ADMIN_SECRET;

export async function apiRequest<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const res = await fetch(input, {
    ...init,
    cache: method === "GET" ? "no-store" : init?.cache,
    headers: {
      "Content-Type": "application/json",
      ...(SHARED_SECRET ? { "X-Api-Secret": SHARED_SECRET } : {}),
      ...(init?.headers || {}),
    },
  });

  const payload = await parseJsonSafe(res);
  if (!res.ok) {
    const message =
      payload?.error || payload?.message || `Request failed (${res.status})`;
    const err = new Error(message) as Error & { missingFields?: string[] };
    if (Array.isArray(payload?.missingFields)) err.missingFields = payload.missingFields;
    throw err;
  }

  return (payload?.data ?? payload) as T;
}
