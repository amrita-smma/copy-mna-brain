import { NextResponse } from 'next/server';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';
import { CorrespondentNotFoundError } from '@/lib/services/crmService';
import {
  DealCompanyNotFoundError,
  DealContactLinkNotFoundError,
  InvalidDealContactRoleError,
} from '@/lib/services/dealContactService';

/** Maps the contact routes' typed errors to HTTP responses; anything else is a 500. */
export function crmContactErrorResponse(error: unknown, tag: string): NextResponse {
  if (error instanceof ContactNotFoundError || error instanceof CorrespondentNotFoundError) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }
  if (error instanceof DealCompanyNotFoundError) {
    return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  }
  if (error instanceof DealContactLinkNotFoundError) {
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }
  if (error instanceof InvalidDealContactRoleError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error(tag, error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
