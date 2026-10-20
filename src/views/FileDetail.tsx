"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import {
  FileDetailActions,
  FileDetailBody,
  type FileRecord,
} from "@/components/Files/FileDetail";
import { FundUpdateReviewDialog } from "@/components/Files/FundUpdateReviewDialog";
import { Button } from "@/components/ui/button";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";
import { downloadSmartFile, reprocessSmartFile } from "@/lib/api/files";
import { isSmartFilesTab } from "@/lib/smartFilesTabs";

interface FileDetailViewProps {
  file: FileRecord;
}

/**
 * A file on its own page (`/files/[id]`) — the deeplink for the Smart Files
 * "View details" dialog. Renders the same `FileDetailActions` /
 * `FileDetailBody` the dialog does, laid out to fill the page the way the
 * dialog fills the screen.
 */
export default function FileDetailView({ file }: FileDetailViewProps) {
  const router = useRouter();
  const [reprocessing, setReprocessing] = useState(false);
  const [viewFundUpdateFileId, setViewFundUpdateFileId] = useState<string | null>(null);
  // Back to the tab this file lives in; unclassified types land in `other`,
  // the same catch-all bucket the Smart Files table files them under.
  const smartFilesHref = useWorkspaceHref(
    `/smart-files/${file.file_type && isSmartFilesTab(file.file_type) ? file.file_type : "other"}`,
  );

  const handleReprocess = async (id: string) => {
    setReprocessing(true);
    try {
      const { isAsync } = await reprocessSmartFile(id);
      posthog.capture("file_reprocessed", { file_id: id });
      toast.success(isAsync ? "File processing started" : "File reprocessed successfully");
      router.refresh();
    } catch (error) {
      console.error("Reprocess error:", error);
      toast.error((error as Error).message || "Failed to reprocess file");
    } finally {
      setReprocessing(false);
    }
  };

  const handleDownload = async () => {
    try {
      await downloadSmartFile(file.id, file.file_name);
    } catch (error) {
      console.error("Download error:", error);
      toast.error("Failed to download file. Please try again.");
    }
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-4 bg-background p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="sm" asChild className="-ml-2 flex-shrink-0">
              <Link href={smartFilesHref} data-testid="file-detail-back">
                <ArrowLeft className="h-4 w-4 mr-1" />
                Smart Files
              </Link>
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold leading-none tracking-tight">
              {file.file_name} - Details
            </h1>
          </div>
          <FileDetailActions
            file={file}
            reprocessing={reprocessing}
            onReprocess={(id) => void handleReprocess(id)}
          />
        </div>
        <FileDetailBody
          file={file}
          onDownload={handleDownload}
          onViewFundUpdateParsed={setViewFundUpdateFileId}
        />
      </div>

      {viewFundUpdateFileId && (
        <FundUpdateReviewDialog
          fileId={viewFundUpdateFileId}
          open={!!viewFundUpdateFileId}
          readOnly
          onClose={() => setViewFundUpdateFileId(null)}
          onApproved={() => setViewFundUpdateFileId(null)}
        />
      )}
    </>
  );
}
