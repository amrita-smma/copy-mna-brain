import type { Metadata } from 'next';
import { LegalDocumentView } from '@/components/legal/LegalDocumentView';
import { legalConfig } from '@/lib/legal/config';
import { privacyPolicy } from '@/lib/legal/documents';

export const metadata: Metadata = {
  title: 'Privacy Policy — Investment Brain',
  description: 'How Investment Brain handles your information, including Google user data from Gmail.',
};

// Public: no session, outside the proxy matcher. Rendered per request so the
// operator's LEGAL_* settings apply without a rebuild.
export const dynamic = 'force-dynamic';

export default function PrivacyPage() {
  return <LegalDocumentView document={privacyPolicy(legalConfig())} current="privacy" />;
}
