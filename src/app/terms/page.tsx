import type { Metadata } from 'next';
import { LegalDocumentView } from '@/components/legal/LegalDocumentView';
import { legalConfig } from '@/lib/legal/config';
import { termsOfService } from '@/lib/legal/documents';

export const metadata: Metadata = {
  title: 'Terms of Service — Investment Brain',
  description: 'The terms for using Investment Brain.',
};

// Public: no session, outside the proxy matcher. Rendered per request so the
// operator's LEGAL_* settings apply without a rebuild.
export const dynamic = 'force-dynamic';

export default function TermsPage() {
  return <LegalDocumentView document={termsOfService(legalConfig())} current="terms" />;
}
