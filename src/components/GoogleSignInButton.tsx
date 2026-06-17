'use client';

import { useEffect, useRef } from 'react';

/**
 * Renders the official "Sign in with Google" button via Google Identity
 * Services (GIS). On a successful Google sign-in, GIS invokes our callback with
 * `response.credential` — a Google-issued ID token (JWT). That token is handed
 * straight to `onCredential`; the server (`/api/auth/google-signin` and the
 * `google-sso` NextAuth provider) verifies it against Google and resolves the
 * local user. We never request OAuth scopes — this is authentication only.
 */

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleSignInButtonProps {
  onCredential: (token: string) => void;
  /** Visually/functionally disable the button while a sign-in is in flight. */
  disabled?: boolean;
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';

// Shared loader so the GIS script is injected at most once per page.
let gisScriptPromise: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisScriptPromise) return gisScriptPromise;

  gisScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')));
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
  return gisScriptPromise;
}

export function GoogleSignInButton({ onCredential, disabled = false }: GoogleSignInButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep the latest callback without re-initializing GIS on every render.
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;

  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId || !containerRef.current) return;
    let cancelled = false;

    loadGisScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response: GoogleCredentialResponse) => {
            if (response.credential) onCredentialRef.current(response.credential);
          },
        });
        window.google.accounts.id.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: 320,
        });
      })
      .catch((err) => {
        console.error('[auth] Google Identity Services failed to load:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (!clientId) return null;

  return (
    <div
      className={disabled ? 'pointer-events-none opacity-60' : undefined}
      aria-disabled={disabled}
    >
      <div className="flex justify-center">
        {/* GIS renders its button inside a fixed-width iframe; this wrapper is
            sized to it so the drop shadow hugs the button rather than the full
            card width. `opacity` blends it into the glassmorphism design. */}
        <div
          ref={containerRef}
          className="overflow-hidden rounded-md opacity-90 shadow-lg shadow-black/20 transition-opacity duration-200 hover:opacity-100 dark:shadow-black/40"
        />
      </div>
    </div>
  );
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: {
            client_id: string;
            callback: (response: GoogleCredentialResponse) => void;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}
