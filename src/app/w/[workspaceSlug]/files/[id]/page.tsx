import { notFound } from 'next/navigation';
import FileDetailView from '@/views/FileDetail';
import type { FileRecord } from '@/components/Files/FileDetail';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { isUuid } from '@/lib/uuid';

/**
 * A file on its own page — the deeplink for a Smart Files row. Shows exactly
 * what the row's "View details" dialog shows (preview + AI structured notes).
 */
export default async function FilePage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const { fileService } = createContainer(createDb(), await getActiveWorkspaceId());
  let file: FileRecord;
  try {
    file = (await fileService.getDetail(id)) as FileRecord;
  } catch (error) {
    if (/not found/i.test((error as Error).message)) notFound();
    throw error;
  }

  // Keyed by id so moving between two files' pages remounts the view rather
  // than carrying one file's reprocess/dialog state onto the next.
  return <FileDetailView key={file.id} file={file} />;
}
