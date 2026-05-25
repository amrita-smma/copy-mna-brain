"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CompanyPicker } from "./CompanyPicker";
import type { CompanyPickerValue, FlaggedEmployer } from "./types";

export function CurationDialog({
  open,
  onOpenChange,
  onResolved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onResolved: () => void;
}) {
  const [queue, setQueue] = useState<FlaggedEmployer[]>([]);
  const [idx, setIdx] = useState(0);
  const [firm, setFirm] = useState<CompanyPickerValue | null>(null);
  const [picName, setPicName] = useState("");
  const [picTitle, setPicTitle] = useState("");
  const [picEmail, setPicEmail] = useState("");
  const [picPhone, setPicPhone] = useState("");

  useEffect(() => {
    if (!open) return;
    fetch("/api/crm/flagged")
      .then((r) => r.json())
      .then((j) => {
        setQueue((j.data ?? []) as FlaggedEmployer[]);
        setIdx(0);
      });
  }, [open]);

  const current = queue[idx];
  useEffect(() => {
    if (!current) return;
    setFirm({ name: current.name, id: current.id });
    setPicName(current.primary_pic?.name ?? "");
    setPicTitle(current.primary_pic?.title ?? "");
    setPicEmail(current.primary_pic?.email ?? "");
    setPicPhone(current.primary_pic?.phone ?? "");
  }, [current]);

  const advance = () => {
    if (idx + 1 < queue.length) setIdx(idx + 1);
    else {
      onOpenChange(false);
      onResolved();
    }
  };

  const decide = async (decision: "approve" | "skip") => {
    if (!current) return;
    const patch =
      decision === "approve"
        ? {
            name: firm?.name ?? current.name,
            primary_pic: {
              name: picName.trim() || null,
              title: picTitle.trim() || null,
              email: picEmail.trim() || null,
              phone: picPhone.trim() || null,
            },
          }
        : {};
    const res = await fetch(`/api/crm/employers/${current.id}/curate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, patch }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error || "Failed to record decision");
      return;
    }
    toast.success(
      decision === "approve"
        ? "Record approved and published"
        : "Skipped — left in queue",
    );
    advance();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review flagged records</DialogTitle>
        </DialogHeader>
        {queue.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Nothing to curate — the queue is clear.
          </p>
        ) : !current ? (
          <p className="py-4 text-sm text-muted-foreground">Done.</p>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-orange-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-orange-500 to-orange-400 transition-all"
                  style={{
                    width: `${((idx + 1) / queue.length) * 100}%`,
                  }}
                />
              </div>
              <span>
                Record {idx + 1} of {queue.length}
              </span>
            </div>
            <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
              <div>
                <Label className="mb-1 block text-[10px] uppercase">
                  Company
                </Label>
                <CompanyPicker value={firm} onChange={setFirm} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-[10px] uppercase">PIC Name</Label>
                  <Input
                    value={picName}
                    onChange={(e) => setPicName(e.target.value)}
                    placeholder="Unknown — fill in"
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase">Title</Label>
                  <Input
                    value={picTitle}
                    onChange={(e) => setPicTitle(e.target.value)}
                    placeholder="Unknown — fill in"
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase">Email</Label>
                  <Input
                    value={picEmail}
                    onChange={(e) => setPicEmail(e.target.value)}
                    placeholder="Unknown — fill in"
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase">Phone</Label>
                  <Input
                    value={picPhone}
                    onChange={(e) => setPicPhone(e.target.value)}
                    placeholder="Not found"
                  />
                </div>
              </div>
            </div>
          </>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => decide("skip")}
            disabled={!current}
          >
            Skip for now
          </Button>
          <Button onClick={() => decide("approve")} disabled={!current}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
