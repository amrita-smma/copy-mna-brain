import type { SVGProps } from 'react';
import { CalendarCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Small, simplified brand marks for the Connected apps list and the sidebar
 * "Connect Apps" button. Drawn inline (no network fetch, no icon dependency)
 * on a 24×24 grid; size them with `className` (`h-4 w-4`).
 */

type IconProps = SVGProps<SVGSVGElement>;

export function GmailIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect x="2" y="5.5" width="4" height="13.5" rx="1" fill="#4285F4" />
      <rect x="18" y="5.5" width="4" height="13.5" rx="1" fill="#34A853" />
      <path
        d="M2 7.2 12 14.4l10-7.2v-.4c0-1.3-1.4-2-2.4-1.3L12 11 4.4 5.5C3.4 4.8 2 5.5 2 6.8z"
        fill="#EA4335"
      />
      <path d="M18 5.9 19.6 4.8c1-.7 2.4 0 2.4 1.3v1.1l-4 2.9z" fill="#FBBC04" />
    </svg>
  );
}

export function GoogleDriveIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <polygon points="8.5,3 12,9 5,21 1.5,15" fill="#00AC47" />
      <polygon points="8.5,3 15.5,3 22.5,15 15.5,15" fill="#FFBA00" />
      <polygon points="5,21 8.5,15 22.5,15 19,21" fill="#2684FC" />
    </svg>
  );
}

export function GoogleCalendarIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" fill="#4285F4" />
      <rect x="5.5" y="8" width="13" height="10.5" rx="1" fill="#FFFFFF" />
      <text
        x="12"
        y="16.6"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="700"
        fontFamily="Arial, sans-serif"
        fill="#4285F4"
      >
        31
      </text>
    </svg>
  );
}

export function OutlookIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" fill="#0078D4" />
      <circle cx="12" cy="12" r="4.5" fill="none" stroke="#FFFFFF" strokeWidth="2.2" />
    </svg>
  );
}

export function SlackIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect x="3" y="8" width="12" height="3" rx="1.5" fill="#36C5F0" />
      <rect x="13" y="3" width="3" height="12" rx="1.5" fill="#2EB67D" />
      <rect x="9" y="13" width="12" height="3" rx="1.5" fill="#ECB22E" />
      <rect x="8" y="9" width="3" height="12" rx="1.5" fill="#E01E5A" />
    </svg>
  );
}

/** MoM AI Intelligent has no public brand mark; a calendar-check tile stands in. */
export function MeetingIntelligenceIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground', className)}
    >
      <CalendarCheck className="h-[70%] w-[70%]" />
    </span>
  );
}
