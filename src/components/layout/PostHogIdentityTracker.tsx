'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '@/hooks/useAuth';
import {
  EMAIL_SUPER_PROPERTY,
  needsIdentify,
  personPropertiesFor,
  superPropertiesFor,
} from '@/lib/posthog-identity';

/**
 * Tells PostHog who the current user is, once the NextAuth session resolves.
 *
 * This deliberately replaces the old `posthog.identify()` call on the login
 * page: `identify()` captures a `$identify` event, and `before_send` drops
 * every event captured on `/login`, so that call never reached PostHog. The
 * fallout was invisible — later events still carried the distinct id (it's
 * persisted locally), so a person eventually appeared, but without the `email`
 * / `name` properties the dropped `$identify` was carrying and without the
 * anonymous -> identified merge. Searching PostHog by email found nothing.
 *
 * Mounted once in `Providers`, above the routed page, so it covers every
 * authenticated surface — including `/workspace`, which sits outside the
 * `/w/<slug>` layout where `PostHogWorkspaceTracker` lives.
 *
 * `setPersonProperties` is called alongside `identify` rather than relying on
 * identify's own `$set`: identify is a one-shot (it no-ops once the distinct id
 * matches), so a user whose name or email changed later would otherwise keep
 * the values captured at first sign-in forever.
 */
export default function PostHogIdentityTracker() {
  const { user } = useAuth();
  const userId = user?.id;
  const email = user?.email;
  const name = user?.name;

  useEffect(() => {
    if (!userId) return;

    const user = { id: userId, email, name };

    // Email on every event, alongside the UUID that is already the distinct id.
    // Registered before identify so the very next event carries it. `null`
    // means stop sending — and must actively clear, since super properties
    // live in localStorage and would otherwise outlive the code change.
    const superProperties = superPropertiesFor(user);
    if (superProperties) {
      posthog.register(superProperties);
    } else {
      posthog.unregister(EMAIL_SUPER_PROPERTY);
    }

    const properties = personPropertiesFor(user);

    if (needsIdentify(posthog.get_distinct_id(), userId)) {
      posthog.identify(userId, properties);
      return;
    }
    // Already identified as this user — refresh the properties only.
    if (Object.keys(properties).length > 0) {
      posthog.setPersonProperties(properties);
    }
  }, [userId, email, name]);

  return null;
}
