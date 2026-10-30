'use client';

import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  GmailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  MeetingIntelligenceIcon,
  OutlookIcon,
  SlackIcon,
} from '@/components/integrations/AppIcons';
import {
  disconnectMeetingIntelligence,
  getMeetingIntelligenceConnection,
  meetingIntelligenceConnectUrl,
  type MeetingIntelligenceConnection,
} from '@/lib/api/meetingIntelligence';
import { RESULT_PARAM } from '@/lib/meetingIntelligence/returnTo';
import { RESULT_PARAM as GMAIL_RESULT_PARAM } from '@/lib/gmail/returnTo';
import { disconnectGmail, getGmailConnection, gmailConnectUrl, type GmailConnection } from '@/lib/api/gmail';

/** Integrations on the roadmap, listed so members know what's coming. */
const COMING_SOON_APPS: { name: string; description: string; Icon: ComponentType<{ className?: string }> }[] = [
  { name: 'Google Drive', description: 'Bring your Drive documents into answers.', Icon: GoogleDriveIcon },
  { name: 'Google Calendar', description: 'Ask about your schedule and upcoming meetings.', Icon: GoogleCalendarIcon },
  { name: 'Microsoft Outlook', description: 'Mail and calendar from Microsoft 365.', Icon: OutlookIcon },
  { name: 'Slack', description: 'Search conversations in your Slack channels.', Icon: SlackIcon },
];

/** What the connect round-trip's `?meetingIntelligenceReason=` means, in words. */
function describeFailure(reason: string | null): string {
  switch (reason) {
    case 'access_denied':
      return 'You declined the connection.';
    case 'invalid_redirect_uri':
      return "This app's address isn't approved by Meeting Intelligence yet. Ask an administrator.";
    case 'expired':
      return 'The sign-in took too long. Please try again.';
    case 'not_enabled':
      return 'Meeting Intelligence is not turned on for this workspace.';
    default:
      return 'Could not connect Meeting Intelligence. Please try again.';
  }
}

/** What the Gmail connect round-trip's `?gmailReason=` means, in words. */
function describeGmailFailure(reason: string | null): string {
  switch (reason) {
    case 'access_denied':
      return 'You declined the connection.';
    case 'missing_scope':
      return 'Gmail was not connected: the permission to read your mail was left unticked. Connect again and keep it ticked.';
    case 'no_refresh_token':
      return 'Google did not complete the connection. Please try again.';
    case 'expired':
      return 'The sign-in took too long. Please try again.';
    case 'not_enabled':
      return 'Gmail is not turned on for this workspace.';
    case 'not_configured':
      return "Gmail isn't set up on this server yet. Ask an administrator.";
    default:
      return 'Could not connect Gmail. Please try again.';
  }
}

function AppRow({
  icon,
  name,
  description,
  detail,
  action,
  testId,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  detail?: ReactNode;
  action: ReactNode;
  testId?: string;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3.5" data-testid={testId}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-card">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
        {detail}
      </div>
      <div className="shrink-0">{action}</div>
    </li>
  );
}

/**
 * Meeting Intelligence (MoM AI Intelligent): an integration that connects. Connecting is a full-page redirect to its sign-in; on return the
 * `?meetingIntelligence=` param is toasted and stripped from the URL. When the
 * workspace's MEETING_INTELLIGENCE_ENABLED flag is off the row stays listed but
 * says so, rather than disappearing.
 */
function MeetingIntelligenceRow({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<MeetingIntelligenceConnection | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getMeetingIntelligenceConnection()
      .then((c) => !cancelled && setConnection(c))
      .catch(() => !cancelled && setConnection(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // Toast the outcome of a connect round-trip once, then drop the params so a
  // refresh doesn't toast again.
  const outcome = searchParams.get(RESULT_PARAM);
  const reason = searchParams.get(`${RESULT_PARAM}Reason`);
  useEffect(() => {
    if (!outcome) return;
    if (outcome === 'connected') toast.success('Meeting Intelligence connected');
    else toast.error(describeFailure(reason));
    const next = new URLSearchParams(searchParams.toString());
    next.delete(RESULT_PARAM);
    next.delete(`${RESULT_PARAM}Reason`);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [outcome, reason, pathname, router, searchParams]);

  const handleConnect = useCallback(() => {
    const query = searchParams.toString();
    window.location.assign(meetingIntelligenceConnectUrl(query ? `${pathname}?${query}` : pathname));
  }, [pathname, searchParams]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await disconnectMeetingIntelligence();
      setConnection((prev) =>
        prev ? { ...prev, connected: false, externalName: null, externalEmail: null, connectedAt: null } : prev,
      );
      toast.success('Meeting Intelligence disconnected');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setDisconnecting(false);
    }
  }, []);

  const connected = enabled && Boolean(connection?.connected);
  const who = [connection?.externalName, connection?.externalEmail].filter(Boolean).join(' · ');

  let action: ReactNode;
  if (!enabled) {
    action = <Badge variant="secondary">Not enabled</Badge>;
  } else if (loading) {
    action = <Skeleton className="h-8 w-20 rounded-md" />;
  } else if (connected) {
    action = (
      <Button
        variant="outline"
        size="sm"
        onClick={handleDisconnect}
        disabled={disconnecting}
        data-testid="meeting-intelligence-disconnect"
      >
        {disconnecting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        Disconnect
      </Button>
    );
  } else {
    action = (
      <Button size="sm" onClick={handleConnect} data-testid="meeting-intelligence-connect">
        Connect
      </Button>
    );
  }

  return (
    <AppRow
      testId="meeting-intelligence-row"
      icon={<MeetingIntelligenceIcon className="h-6 w-6" />}
      name="MoM Intelligent"
      description={
        !enabled
          ? 'Meeting recaps, action items and calendars. Ask an administrator to turn it on for this workspace.'
          : connected
            ? 'The Copilot can read your meeting recaps, action items and calendar.'
            : 'Let the Copilot answer questions about your meetings, action items and calendar. Read-only.'
      }
      detail={
        connected && who ? (
          <span className="truncate text-xs text-muted-foreground" data-testid="meeting-intelligence-account">
            Connected as {who}
          </span>
        ) : null
      }
      action={action}
    />
  );
}

/**
 * Gmail: connecting is a full-page redirect to Google's consent screen; on
 * return the `?gmail=` param is toasted and stripped from the URL. Bots read
 * the mailbox and save drafts; they never send. A connection made before draft
 * access existed (or with that box unticked) offers Reconnect.
 * Like the Meeting Intelligence row, it stays listed with "Not enabled" when the
 * workspace's GMAIL_ENABLED flag is off, rather than disappearing.
 */
function GmailRow({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<GmailConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  // Loaded even when the workspace flag is off: a member who connected before
  // an admin turned it off must still be able to withdraw access.
  useEffect(() => {
    let cancelled = false;
    getGmailConnection()
      .then((c) => !cancelled && setConnection(c))
      .catch(() => !cancelled && setConnection(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Toast the outcome of a connect round-trip once, then drop the params so a
  // refresh doesn't toast again.
  const outcome = searchParams.get(GMAIL_RESULT_PARAM);
  const reason = searchParams.get(`${GMAIL_RESULT_PARAM}Reason`);
  useEffect(() => {
    if (!outcome) return;
    if (outcome === 'connected') toast.success('Gmail connected');
    else toast.error(describeGmailFailure(reason));
    const next = new URLSearchParams(searchParams.toString());
    next.delete(GMAIL_RESULT_PARAM);
    next.delete(`${GMAIL_RESULT_PARAM}Reason`);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [outcome, reason, pathname, router, searchParams]);

  const handleConnect = useCallback(() => {
    const query = searchParams.toString();
    window.location.assign(gmailConnectUrl(query ? `${pathname}?${query}` : pathname));
  }, [pathname, searchParams]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await disconnectGmail();
      setConnection((prev) =>
        prev ? { ...prev, connected: false, googleEmail: null, connectedAt: null, canDraft: false } : prev,
      );
      toast.success('Gmail disconnected');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setDisconnecting(false);
    }
  }, []);

  const connected = Boolean(connection?.connected);
  const needsReconnect = enabled && connected && connection?.canDraft === false;
  const notConfigured = enabled && !loading && connection !== null && !connection.configured && !connected;

  let action: ReactNode;
  if (loading) {
    action = <Skeleton className="h-8 w-20 rounded-md" />;
  } else if (!enabled && !connected) {
    action = <Badge variant="secondary">Not enabled</Badge>;
  } else if (connected) {
    action = (
      <div className="flex items-center gap-2">
        {needsReconnect && (
          <Button size="sm" onClick={handleConnect} data-testid="gmail-reconnect">
            Reconnect
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={disconnecting} data-testid="gmail-disconnect">
          {disconnecting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Disconnect
        </Button>
      </div>
    );
  } else if (notConfigured) {
    action = <Badge variant="secondary">Not set up</Badge>;
  } else {
    action = (
      <Button size="sm" onClick={handleConnect} data-testid="gmail-connect">
        Connect
      </Button>
    );
  }

  return (
    <AppRow
      testId="gmail-row"
      icon={<GmailIcon className="h-6 w-6" />}
      name="Gmail"
      description={
        !enabled && connected
          ? 'Gmail is turned off for this workspace, so your bots cannot read your mail. You can still disconnect it.'
          : !enabled
            ? 'Search and read your email in chat. Ask an administrator to turn it on for this workspace.'
            : notConfigured
            ? "Gmail isn't set up on this server yet. Ask an administrator."
            : needsReconnect
              ? 'Your bots can search and read your Gmail in chat. Reconnect to also let them save the emails they write as drafts for you.'
              : connected
                ? 'Your bots can search and read your Gmail in chat, and save the emails they write as drafts for you to review and send. They never send mail themselves.'
                : 'Let your bots search and read your Gmail in chat, and save the emails they write as drafts for you to review and send. They never send, change or delete mail themselves.'
      }
      detail={
        connected && connection?.googleEmail ? (
          <span className="truncate text-xs text-muted-foreground" data-testid="gmail-account">
            Connected as {connection.googleEmail}
          </span>
        ) : null
      }
      action={action}
    />
  );
}

/**
 * Profile → Connected apps: the apps a member can connect so the Copilot can
 * work with them. Reached from the sidebar's "Connect Apps" button.
 *
 * `meetingIntelligenceEnabled` and `gmailEnabled` are the workspace's
 * MEETING_INTELLIGENCE_ENABLED and GMAIL_ENABLED flags, resolved server-side in
 * the page and passed down.
 */
export default function ConnectedAppsTab({
  meetingIntelligenceEnabled,
  gmailEnabled,
}: {
  meetingIntelligenceEnabled: boolean;
  gmailEnabled: boolean;
}) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4" data-testid="connected-apps">
      <section className="rounded-xl border bg-card">
        <h2 className="px-4 pb-1 pt-4 text-sm font-semibold">Available</h2>
        <ul className="divide-y">
          <MeetingIntelligenceRow enabled={meetingIntelligenceEnabled} />
          <GmailRow enabled={gmailEnabled} />
        </ul>
      </section>

      <section className="rounded-xl border bg-card">
        <h2 className="px-4 pb-1 pt-4 text-sm font-semibold">Coming soon</h2>
        <ul className="divide-y">
          {COMING_SOON_APPS.map(({ name, description, Icon }) => (
            <AppRow
              key={name}
              icon={<Icon className="h-5 w-5" />}
              name={name}
              description={description}
              action={<Badge variant="outline">Coming Soon</Badge>}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
