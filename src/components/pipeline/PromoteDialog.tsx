import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import {
  FileText,
  Link as LinkIcon,
  Upload,
  Loader2,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
} from "lucide-react";
import { DealStage } from "@/lib/types";
import { stageMoveLabel } from "@/lib/constants";
import { usePipelineStages } from "@/hooks/usePipelineStages";
import { promoteCompany } from "@/lib/api/pipeline";
import { apiRequest } from "@/lib/api/client";

interface PromoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  companyName: string;
  currentStage: DealStage;
  nextStage: DealStage;
  onSuccess: () => void;
  mode?: "promote" | "demote";
}

export default function PromoteDialog({
  open,
  onOpenChange,
  dealId,
  companyName,
  currentStage,
  nextStage,
  onSuccess,
  mode = "promote",
}: PromoteDialogProps) {
  const { user } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [promotionReason, setPromotionReason] = useState("");
  const [note, setNote] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  // `unreviewed` is the demote target out of L0; spell it as the section the
  // deal actually lands in rather than the raw stage value.
  const { code: stageCode } = usePipelineStages();
  const nextStageLabel = stageMoveLabel(nextStage, stageCode);

  const handlePromote = async () => {
    setIsSubmitting(true);
    try {
      // Promote and persist optional note/link in a single server-side action.
      const logDetails: string[] = [];
      if (note.trim()) logDetails.push(`Note: ${note}`);
      if (linkUrl.trim()) logDetails.push(`Link: ${linkTitle || linkUrl}`);
      if (selectedFile) logDetails.push(`Document: ${selectedFile.name}`);
      await promoteCompany(dealId, {
        currentStage,
        nextStage,
        note,
        linkUrl,
        linkTitle,
        promotionReason:
          mode === "promote" && promotionReason.trim()
            ? promotionReason
            : undefined,
        // Telemetry only — the document is uploaded further down, after this
        // call returns, so the server-side capture can't observe it otherwise.
        hasDocument: selectedFile !== null,
      });

      // The Company Card is refreshed server-side on every stage move (see
      // CompanyService.promote → CompanyAnalysisService.regenerate), so there
      // is no client-side trigger here — a second POST would enqueue a
      // duplicate workforce run for a company that has no card yet.

      // 3. Upload and Save Document
      if (selectedFile) {
        try {
          const contentType = selectedFile.type || "application/octet-stream";

          // 1. Get presigned URL
          let uploadUrlData: { uploadUrl: string; key: string };
          try {
            uploadUrlData = await apiRequest(
              `/api/deal-documents/upload-url?dealId=${encodeURIComponent(dealId)}&fileName=${encodeURIComponent(selectedFile.name)}&contentType=${encodeURIComponent(contentType)}`,
            );
          } catch (apiErr: any) {
            throw new Error(
              apiErr?.message || "Could not reach server to get upload URL.",
            );
          }

          const { uploadUrl, key } = uploadUrlData;

          // 2. Upload to S3
          let s3Res: Response;
          try {
            s3Res = await fetch(uploadUrl, {
              method: "PUT",
              body: selectedFile,
              headers: { "Content-Type": contentType },
            });
          } catch (netErr) {
            throw new Error("Upload to storage failed (network error).");
          }

          if (!s3Res.ok) throw new Error("Failed to upload file to storage");

          // 3. Register document in database
          try {
            await apiRequest("/api/deal-documents", {
              method: "POST",
              body: JSON.stringify({
                dealId: dealId,
                key,
                fileName: selectedFile.name,
                fileSize: selectedFile.size,
                mimeType: selectedFile.type || null,
                stage: currentStage,
              }),
            });
          } catch (apiErr: any) {
            throw new Error(
              apiErr?.message || "Failed to register document",
            );
          }
        } catch (docError: any) {
          console.error("Error handling document upload:", docError);
          toast.error(`Document upload failed: ${docError.message}`);
          // We don't re-throw here so the promotion itself (which likely succeeded) isn't rolled back in UI terms
        }
      }

      // `deal_promoted` / `deal_demoted` are captured server-side in
      // `CompanyService.promote` — an ad blocker can't drop those, and they
      // also cover stage moves made by the agent tools and bulk triage, which
      // never touch this dialog.

      toast.success(
        mode === "demote"
          ? `Demoted to ${nextStageLabel}`
          : `Promoted to ${nextStageLabel}`,
      );
      resetForm();
      onOpenChange(false);
      onSuccess();
    } catch (error: any) {
      console.error("Error promoting company:", error);
      if (Array.isArray(error.missingFields)) {
        setMissingFields(error.missingFields);
      } else {
        toast.error(
          `Failed to ${mode === "demote" ? "demote" : "promote"} company: ${error.message || "Unknown error"}`,
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setPromotionReason("");
    setNote("");
    setLinkUrl("");
    setLinkTitle("");
    setSelectedFile(null);
    setMissingFields([]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) resetForm();
        onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === "demote"
              ? `Demote to ${nextStageLabel}`
              : `Promote to ${nextStageLabel}`}
          </DialogTitle>
          <DialogDescription>
            {mode === "demote" ? (
              <>
                Move <span className="font-medium">{companyName}</span> back
                from {stageMoveLabel(currentStage, stageCode)} to {nextStageLabel}.
              </>
            ) : (
              <>
                Add supporting information before promoting{" "}
                <span className="font-medium">{companyName}</span> from{" "}
                {stageMoveLabel(currentStage, stageCode)} to {nextStageLabel}.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {missingFields.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-destructive">
                  Fill in the required fields before entering the pipeline:
                </p>
                <ul className="mt-1 list-disc list-inside text-sm text-destructive/80 space-y-0.5">
                  {missingFields.map((f) => <li key={f}>{f}</li>)}
                </ul>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Edit the company to fill these in, then try again.
                </p>
              </div>
            </div>
          </div>
        )}

        {mode === "demote" ? (
          <div className="mt-2">
            <Label htmlFor="reason">Reason (optional)</Label>
            <Textarea
              id="reason"
              placeholder="Enter reason for demotion..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              className="mt-1.5"
            />
          </div>
        ) : (
          <>
            <Tabs defaultValue="note" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="note" className="gap-1">
                  <FileText className="h-3 w-3" />
                  Note
                </TabsTrigger>
                <TabsTrigger value="link" className="gap-1">
                  <LinkIcon className="h-3 w-3" />
                  Link
                </TabsTrigger>
                <TabsTrigger value="document" className="gap-1">
                  <Upload className="h-3 w-3" />
                  Document
                </TabsTrigger>
              </TabsList>

              <TabsContent value="note" className="mt-4 space-y-3">
                <div>
                  <Label htmlFor="promotionReason">Promotion reason</Label>
                  <Textarea
                    id="promotionReason"
                    placeholder={
                      "- strong FY2024 growth\n- good EBITDA\n- high customer satisfaction"
                    }
                    value={promotionReason}
                    onChange={(e) => setPromotionReason(e.target.value)}
                    rows={4}
                    className="mt-1.5 font-mono text-sm"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Supports markdown. Appended below any prior promotion
                    reasons on this company.
                  </p>
                </div>
                <div>
                  <Label htmlFor="note">Add a note (optional)</Label>
                  <Textarea
                    id="note"
                    placeholder="Enter notes about this promotion..."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={4}
                    className="mt-1.5"
                  />
                </div>
              </TabsContent>

              <TabsContent value="link" className="mt-4 space-y-3">
                <div>
                  <Label htmlFor="linkUrl">URL</Label>
                  <Input
                    id="linkUrl"
                    placeholder="https://..."
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="linkTitle">Title (optional)</Label>
                  <Input
                    id="linkTitle"
                    placeholder="Link description..."
                    value={linkTitle}
                    onChange={(e) => setLinkTitle(e.target.value)}
                    className="mt-1.5"
                  />
                </div>
              </TabsContent>

              <TabsContent value="document" className="mt-4 space-y-3">
                <div>
                  <Label htmlFor="document">Upload Document</Label>
                  <div className="mt-1.5">
                    <Input
                      id="document"
                      type="file"
                      onChange={handleFileChange}
                      className="cursor-pointer"
                    />
                  </div>
                  {selectedFile && (
                    <p className="text-sm text-muted-foreground mt-2">
                      Selected: {selectedFile.name}
                    </p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}

        <DialogFooter className="mt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handlePromote}
            disabled={isSubmitting}
            variant={mode === "demote" ? "destructive" : "default"}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {mode === "demote" ? "Demoting..." : "Promoting..."}
              </>
            ) : mode === "demote" ? (
              <>
                <ChevronLeft className="mr-1 h-4 w-4" />
                Demote
              </>
            ) : (
              <>
                Promote
                <ChevronRight className="ml-1 h-4 w-4" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
