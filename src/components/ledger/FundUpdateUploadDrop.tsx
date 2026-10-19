'use client';

import { useRef, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useWorkspacePush } from '@/hooks/useWorkspaceHref';
import { uploadSmartFile } from '@/lib/api/files';

const ACCEPT = '.pdf,.xlsx,.xls,.csv,.doc,.docx,.txt,.md';

function carriesFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * "Upload File" drop zone for the ledger-entry dialogs. A file dropped here is
 * a fund update: it goes through the regular Smart Files upload with the
 * category forced to Fund Updates, so the existing fund-update extraction
 * agents/job process it. On success the user is taken to that file in Smart
 * Files (`?file=<id>` opens it there).
 */
export function FundUpdateUploadDrop({
  onNavigate,
  className,
}: {
  /** Called right before redirecting — e.g. to close the hosting dialog. */
  onNavigate?: () => void;
  className?: string;
}) {
  const { toast } = useToast();
  const pushWorkspace = useWorkspacePush();
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const busy = uploadingName !== null;

  const upload = async (file: File) => {
    if (busy) return;
    setUploadingName(file.name);
    try {
      const result = await uploadSmartFile(file, { fileTypeOverride: 'fund_updates' });
      if (result.duplicate) {
        toast({
          title: 'File already uploaded',
          description: `"${file.name}" already exists in Smart Files — opening it.`,
        });
      }
      onNavigate?.();
      pushWorkspace(
        result.id
          ? `/smart-files/fund_updates?file=${encodeURIComponent(result.id)}`
          : '/smart-files/fund_updates',
      );
    } catch (err) {
      console.error('Fund update upload failed', err);
      toast({
        title: 'Upload failed',
        description: err instanceof Error ? err.message : `"${file.name}" was not uploaded.`,
        variant: 'destructive',
      });
      setUploadingName(null);
    }
  };

  const pick = (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    if (list.length > 1) {
      toast({
        title: 'One file at a time',
        description: `Uploading "${list[0].name}" only.`,
      });
    }
    void upload(list[0]);
  };

  return (
    <div
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-disabled={busy}
      aria-label="Upload a fund update file"
      onClick={() => !busy && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!busy && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragEnter={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
      }}
      onDragLeave={(e) => {
        if (!carriesFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (!busy) pick(e.dataTransfer.files);
      }}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md border border-dashed bg-muted px-3 py-3 text-left transition-colors',
        'hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        dragging && 'border-accent bg-accent/10',
        busy && 'cursor-progress opacity-80',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = '';
        }}
      />
      {busy ? (
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <FileUp className="h-5 w-5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground">
          {busy ? `Uploading ${uploadingName}…` : 'Upload File'}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {busy
            ? 'Processing the fund update — you will be taken to it in Smart Files.'
            : 'Drag & drop a fund update here, or click to browse. It is filed under Smart Files → Fund Updates.'}
        </div>
      </div>
    </div>
  );
}
