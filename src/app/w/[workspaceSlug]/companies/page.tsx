import { redirect } from 'next/navigation';

/**
 * `/companies` has no list of its own — Master Data is the overview of every
 * company. Exists so a `/companies/<id>` that doesn't resolve (e.g. after a
 * workspace switch) has somewhere to land.
 */
export default async function CompaniesPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  redirect(`/w/${workspaceSlug}/master-data`);
}
