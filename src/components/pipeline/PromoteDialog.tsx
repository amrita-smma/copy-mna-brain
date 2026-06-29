import { useEffect, useState } from "react";
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
import posthog from "posthog-js";
import {
  getCompanyAssignees,
  getUsers,
  promoteCompany,
  type UserSummary,
} from "@/lib/api/pipeline";
import UserCombobox from "./UserCombobox";

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
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [missingFields, setMissingFields] = useState<string[]>([]);

  useEffect(() => {
    if (!open || mode !== "promote") return;
    let cancelled = false;
    setUsersLoading(true);
    Promise.all([getUsers(), getCompanyAssignees(dealId)])
      .then(([userList, current]) => {
        if (cancelled) return;
        setUsers(userList);
        setAssigneeIds(current.map((u) => u.id));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load users/assignees:", err);
        toast.error("Failed to load users");
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, dealId]);

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
        assigneeIds: mode === "promote" ? assigneeIds : undefined,
        promotionReason:
          mode === "promote" && promotionReason.trim()
            ? promotionReason
            : undefined,
      });

      // Auto-trigger AI Company Card when promoting to L1
      if (nextStage === "L1") {
        fetch("/api/company-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: dealId }),
        }).catch(() => {}); // Silent — don't block promotion on analysis
      }

      // 3. Upload and Save Document
      if (selectedFile) {
        try {
          const contentType = selectedFile.type || "application/octet-stream";

          // 1. Get presigned URL
          let uploadUrlRes: Response;
          try {
            uploadUrlRes = await fetch(
              `/api/deal-documents/upload-url?dealId=${encodeURIComponent(dealId)}&fileName=${encodeURIComponent(selectedFile.name)}&contentType=${encodeURIComponent(contentType)}`,
            );
          } catch (netErr) {
            throw new Error("Could not reach server to get upload URL.");
          }

          if (!uploadUrlRes.ok)
            throw new Error(`Get upload URL failed: ${uploadUrlRes.status}`);

          const uploadUrlData = await uploadUrlRes.json();
          if (!uploadUrlData.success || !uploadUrlData.data) {
            throw new Error(uploadUrlData.error || "Failed to get upload URL");
          }

          const { uploadUrl, key } = uploadUrlData.data;

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
          let registerRes: Response;
          try {
            registerRes = await fetch("/api/deal-documents", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                dealId: dealId,
                key,
                fileName: selectedFile.name,
                fileSize: selectedFile.size,
                mimeType: selectedFile.type || null,
                stage: currentStage,
              }),
            });
          } catch (netErr) {
            throw new Error("Could not register document in database.");
          }

          if (!registerRes.ok)
            throw new Error(`Register document failed: ${registerRes.status}`);

          const registerData = await registerRes.json();
          if (!registerData.success) {
            throw new Error(
              registerData.error || "Failed to register document",
            );
          }
        } catch (docError: any) {
          console.error("Error handling document upload:", docError);
          toast.error(`Document upload failed: ${docError.message}`);
          // We don't re-throw here so the promotion itself (which likely succeeded) isn't rolled back in UI terms
        }
      }

      posthog.capture(mode === "demote" ? "deal_demoted" : "deal_promoted", {
        deal_id: dealId,
        company_name: companyName,
        from_stage: currentStage,
        to_stage: nextStage,
        has_note: note.trim() !== "",
        has_link: linkUrl.trim() !== "",
        has_document: selectedFile !== null,
      });

      toast.success(
        mode === "demote"
          ? `Demoted to ${nextStage}`
          : `Promoted to ${nextStage}`,
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
    setAssigneeIds([]);
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
              ? `Demote to ${nextStage}`
              : `Promote to ${nextStage}`}
          </DialogTitle>
          <DialogDescription>
            {mode === "demote" ? (
              <>
                Move <span className="font-medium">{companyName}</span> back
                from {currentStage} to {nextStage}.
              </>
            ) : (
              <>
                Add supporting information before promoting{" "}
                <span className="font-medium">{companyName}</span> from{" "}
                {currentStage} to {nextStage}.
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
                  Fill in the required fields before adding to L0:
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
            <div className="space-y-1.5">
              <Label>Assignees</Label>
              <UserCombobox
                users={users}
                selectedUserIds={assigneeIds}
                onChange={setAssigneeIds}
                loading={usersLoading}
                disabled={isSubmitting}
              />
            </div>
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
