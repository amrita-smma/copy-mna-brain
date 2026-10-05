import { signOut } from "next-auth/react";
import { isEmbedded, postToLauncher } from "@/lib/iframe";

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

/**
 * Reads the active workspace slug from the current tab's own URL — the
 * per-tab scoping source of truth once routes move under `/w/[workspaceSlug]/`.
 * Returns null on flat routes (`/login`, `/workspace`, `/admin-portal`, ...)
 * and pre-migration, where nothing has a `/w/` prefix yet.
 */
export function getWorkspaceSlugFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/w\/([^/]+)(?:\/|$)/);
  return match ? match[1] : null;
}

function isSameOriginTarget(target: RequestInfo | URL): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (typeof target === "string") {
      // A bare relative path (`/api/...`) has no origin to parse — treat as
      // same-origin, which is the common case for every call site today.
      if (target.startsWith("/")) return true;
      return new URL(target, window.location.origin).origin === window.location.origin;
    }
    const url = target instanceof Request ? target.url : target.toString();
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Merges an `X-Workspace-Slug` header into `existing`, but only when the
 * target is same-origin — never on a third-party URL (e.g. an S3 presigned
 * upload). This is what makes attaching the header safe by construction,
 * with no opt-out flag needed at call sites like `PromoteDialog.tsx`'s
 * direct-to-S3 upload.
 */
export function buildWorkspaceHeaders(
  target: RequestInfo | URL,
  existing?: HeadersInit,
): HeadersInit {
  const slug = getWorkspaceSlugFromUrl();
  if (!slug || !isSameOriginTarget(target)) return existing ?? {};
  return { ...existing, "X-Workspace-Slug": slug };
}

export async function apiRequest<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const isFormData = init?.body instanceof FormData;
  const res = await fetch(input, {
    ...init,
    cache: method === "GET" ? "no-store" : init?.cache,
    headers: {
      // FormData sets its own multipart boundary in the Content-Type header —
      // forcing JSON here would break every multipart upload through this helper.
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(SHARED_SECRET ? { "X-Api-Secret": SHARED_SECRET } : {}),
      ...buildWorkspaceHeaders(input, init?.headers),
    },
  });

  const payload = await parseJsonSafe(res);
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      if (isEmbedded()) {
        // Inside the launcher iframe, a redirect to /login would render an
        // unusable login page in the frame. Instead signal the launcher to
        // re-launch us with a fresh `?token`, which re-establishes the session
        // via the `/api/auth/sso` deeplink without a navigation here.
        postToLauncher({ type: "auth-expired" });
      } else {
        // Standalone: gracefully kick the user out of the session and redirect
        // to login, which properly invalidates the session on the backend.
        void signOut({ callbackUrl: "/login" });
      }
    }

    const message =
      payload?.error || payload?.message || `Request failed (${res.status})`;
    const err = new Error(message) as Error & {
      missingFields?: string[];
      status?: number;
      code?: string;
    };
    err.status = res.status;
    if (Array.isArray(payload?.missingFields)) err.missingFields = payload.missingFields;
    // A machine-readable reason the caller can branch on (e.g. restore_stage_required).
    if (typeof payload?.code === "string") err.code = payload.code;
    throw err;
  }

  // Unwrap the `{ data }` envelope when present — keyed on the property, not on
  // truthiness, so an explicit `data: null` (e.g. a "not found yet" response)
  // resolves to `null` rather than falling back to the whole envelope object.
  // Raw responses (no `data` key, arrays, primitives) pass through unchanged.
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in payload
  ) {
    return payload.data as T;
  }
  return payload as T;
}
