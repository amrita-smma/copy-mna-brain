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

/** Integrations on the roadmap, listed so members know what's coming. */
const COMING_SOON_APPS: { name: string; description: string; Icon: ComponentType<{ className?: string }> }[] = [
  { name: 'Gmail', description: 'Let the Copilot read and search your email.', Icon: GmailIcon },
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
 * Meeting Intelligence (MoM AI Intelligent): the one integration that connects
 * today. Connecting is a full-page redirect to its sign-in; on return the
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
 * Profile → Connected apps: the apps a member can connect so the Copilot can
 * work with them. Reached from the sidebar's "Connect Apps" button.
 *
 * `meetingIntelligenceEnabled` is the workspace's MEETING_INTELLIGENCE_ENABLED
 * flag, resolved server-side in the page and passed down.
 */
export default function ConnectedAppsTab({ meetingIntelligenceEnabled }: { meetingIntelligenceEnabled: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4" data-testid="connected-apps">
      <section className="rounded-xl border bg-card">
        <h2 className="px-4 pb-1 pt-4 text-sm font-semibold">Available</h2>
        <ul className="divide-y">
          <MeetingIntelligenceRow enabled={meetingIntelligenceEnabled} />
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
