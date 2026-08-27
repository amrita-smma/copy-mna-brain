import { Suspense } from 'react';
import CompanyDetail from '@/views/CompanyDetail';

/**
 * A company on its own terms — where the chat's "Open <company>" chips and
 * company search send you.
 *
 * Renders the same view as `/pipeline/<dealId>`, which reads the company as a
 * deal in the funnel. Both segments are the company id; this route exists
 * because most links to a company aren't about its pipeline position, and
 * `/pipeline/<id>` reads as though they were.
 */
export default async function CompanyPage() {
  return (
    <Suspense fallback={null}>
      <CompanyDetail />
    </Suspense>
  );
}
