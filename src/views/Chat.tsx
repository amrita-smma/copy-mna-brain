'use client';

import DashboardLayout from '@/components/layout/DashboardLayout';

interface ChatProps {
  showCompanyGraph?: boolean;
}

/**
 * Dedicated Chat route, primarily the "Chat" tab of the mobile bottom nav.
 * On mobile, DashboardLayout renders the full-screen AI CoPilot for this
 * route and ignores these children. On desktop the copilot already lives in
 * the right-hand pane, so the main area just shows a hint.
 */
export default function Chat({ showCompanyGraph = false }: ChatProps) {
  return (
    <DashboardLayout showCompanyGraph={showCompanyGraph}>
      <div className="hidden h-full items-center justify-center p-8 text-center text-sm text-muted-foreground md:flex">
        Your AI CoPilot is ready in the panel on the right.
      </div>
    </DashboardLayout>
  );
}
