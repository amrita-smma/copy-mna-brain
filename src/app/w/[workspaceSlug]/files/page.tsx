import { redirect } from 'next/navigation';

/**
 * `/files` has no list of its own — Smart Files is where files are listed.
 * Exists so a `/files/<id>` that doesn't resolve (e.g. after a workspace
 * switch) has somewhere to land.
 */
export default async function FilesPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  redirect(`/w/${workspaceSlug}/smart-files`);
}
