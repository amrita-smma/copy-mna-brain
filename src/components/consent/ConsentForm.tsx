'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest } from '@/lib/api/client';

function Clause({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="text-xs font-mono text-muted-foreground">{n}</div>
      <h3 className="font-display text-base font-semibold">{title}</h3>
      <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export function ConsentForm({ destination }: { destination: string }) {
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signOut, acceptConsent } = useAuth();
  const router = useRouter();

  const handleAgree = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest('/api/consent', { method: 'POST' });
      await acceptConsent();
      router.push(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record consent');
      setSubmitting(false);
    }
  };

  const handleDecline = async () => {
    await signOut();
    router.push('/login');
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      <div className="relative z-10 flex w-full justify-center">
        <Card className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-md bg-card shadow-lg">
          <CardHeader>
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Consent required
            </div>
            <CardTitle className="font-display text-xl font-bold">
              Terms &amp; Consent for Sync
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Please read this in full before enabling automated email signal extraction for your workspace.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex-1 overflow-y-auto text-foreground">
            <div className="space-y-6">
              <Clause n={1} title="About This Application">
                <p>
                  <strong className="text-foreground">BRAIN</strong> is StarCapital&apos;s internal
                  deal-tracking and origination platform. Deal teams use it to monitor companies, correspondents, and
                  transaction signals across active and prospective mandates. Access is restricted to authorized
                  StarCapital personnel and explicitly permitted workspace members, for internal business use only.
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    All data uploaded, synced, or generated within BRAIN — including notes, documents, and any signal
                    extracted through Sync — is the property of <strong className="text-foreground">StarCapital</strong>.
                    You retain no personal or third-party rights over content created or ingested in the course of
                    your work.
                  </li>
                  <li>Your account is personal and non-transferable. Do not share credentials or use another user&apos;s session.</li>
                  <li>Use BRAIN only for legitimate deal-related work. Do not upload personal, non-work, or third-party confidential material you are not authorized to share.</li>
                  <li>StarCapital IT/Compliance may suspend or revoke access at any time, including to any workspace feature described below.</li>
                </ul>
              </Clause>

              <Clause n={2} title="What Sync Does">
                <p>
                  <strong className="text-foreground">Sync</strong> is an optional workspace feature that
                  extracts structured deal signals from email you have already archived to Google Vault — it never
                  reads your live inbox and never asks for your email password.
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>Sync operates on a <strong className="text-foreground">Zero Human Access</strong> basis: no analyst, engineer, or StarCapital staff member ever reads the content of your email at any stage.</li>
                  <li>Sync does not request, store, or use login credentials. Authorization is limited to reading already-exported archive data from Google Vault.</li>
                  <li>Sync does not seek and cannot obtain access to any other application connected to your Google account.</li>
                </ul>
              </Clause>

              <Clause n={3} title="The 4-Layer Privacy Pipeline">
                <p>Every archive Sync touches passes through four automated filters, in order, before anything is stored:</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li><strong className="text-foreground">Internal Domain Blacklist</strong> — personal and internal HR-domain senders are blocked at the header level.</li>
                  <li><strong className="text-foreground">Content Filtering</strong> — subjects/headers are screened for sensitive topics (payroll, performance, benefits) before a body is ever decoded.</li>
                  <li><strong className="text-foreground">Attachment Filtering + AI File Dump</strong> — flagged files (pay slips, contracts, HR documents) are discarded; an AI pass drops anything unrelated to a transaction.</li>
                  <li><strong className="text-foreground">Structured Signal Extraction</strong> — only structured fields are written to the database. Everything else is discarded, permanently.</li>
                </ol>
              </Clause>

              <Clause n={4} title="What's Stored vs. Never Stored">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border border-green-600/30 bg-green-600/10 p-3">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-400">Stored</div>
                    <ul className="list-disc space-y-1 pl-4 text-xs">
                      <li>Company name</li>
                      <li>Signal type</li>
                      <li>Event date</li>
                      <li>Source label</li>
                    </ul>
                  </div>
                  <div className="rounded-md border border-red-600/30 bg-red-600/10 p-3">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-red-700 dark:text-red-400">Never stored</div>
                    <ul className="list-disc space-y-1 pl-4 text-xs">
                      <li>Raw email body</li>
                      <li>Attachments, parsed or not</li>
                      <li>Sender/recipient personal data</li>
                      <li>Anything blocked at any layer</li>
                    </ul>
                  </div>
                </div>
              </Clause>

              <Clause n={5} title="Where Your Data Lives &amp; Your Control">
                <ul className="list-disc space-y-1 pl-5">
                  <li>Extracted signals are stored in a database located in Indonesia.</li>
                  <li>Only members of your own workspace can view your workspace&apos;s signals — nothing is shared across workspaces.</li>
                  <li>Your workspace admin can enable or disable Sync at any time from workspace settings.</li>
                </ul>
                <p className="border-l-2 border-border pl-3 text-xs">
                  This screen summarizes the Sync-specific rules within StarCapital&apos;s Kebijakan Keamanan
                  Informasi (Information Security Policy), which references ISO/IEC 27001, UU No. 27/2022 (PDP), UU
                  ITE, and PP No. 71/2019. Ask IT/Compliance for the full policy document.
                </p>
              </Clause>
            </div>
          </CardContent>

          <CardFooter className="flex flex-col gap-4 border-t border-border pt-4">
            {error && (
              <Alert variant="destructive" className="w-full">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                checked={agreed}
                onCheckedChange={(checked) => setAgreed(checked === true)}
                disabled={submitting}
                className="mt-0.5"
              />
              <span>
                I have read and understood how Sync processes email data, and I agree to StarCapital&apos;s Terms of
                Use and Information Security Policy.
              </span>
            </label>
            <div className="grid w-full grid-cols-2 gap-3">
              <Button type="button" variant="outline" onClick={handleDecline} disabled={submitting}>
                Decline
              </Button>
              <Button type="button" onClick={handleAgree} disabled={!agreed || submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Recording...
                  </>
                ) : (
                  'Agree & Enable Sync'
                )}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
