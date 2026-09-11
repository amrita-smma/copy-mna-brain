"use client";

import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Search, Building2, Layers, Users, Wallet } from "lucide-react";
import type { ReviewEntity, EntityTabKind } from "./types";

interface RemapModalProps {
  open: boolean;
  onClose: () => void;
  entity: ReviewEntity | null;
  allEntities: ReviewEntity[];
  onSaveRemap: (entityKey: string, remapped: { id: string | null; name: string; isNew: boolean }) => void;
}

export function RemapModal({
  open,
  onClose,
  entity,
  allEntities,
  onSaveRemap,
}: RemapModalProps) {
  const [mode, setMode] = useState<"existing" | "new">(
    entity?.status === "matched" ? "existing" : "new",
  );
  const [search, setSearch] = useState("");
  const [selectedMatchName, setSelectedMatchName] = useState<string>(
    entity?.remappedTo?.name || entity?.name || "",
  );
  const [customNewName, setCustomNewName] = useState<string>(
    entity?.remappedTo?.name || entity?.name || "",
  );

  useEffect(() => {
    if (!open || !entity) return;
    setMode(entity.status === "matched" ? "existing" : "new");
    setSearch("");
    setSelectedMatchName(entity.remappedTo?.name || entity.name);
    setCustomNewName(entity.remappedTo?.name || entity.name);
  }, [open, entity]);

  if (!entity) return null;

  // Candidates for existing matches in same category
  const candidates = allEntities.filter(
    (e) => e.tab === entity.tab && e.key !== entity.key && e.status === "matched" && e.matchedId,
  );

  const filteredCandidates = candidates.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.code.toLowerCase().includes(search.toLowerCase()),
  );

  function handleSave() {
    if (!entity) return;
    if (mode === "existing") {
      const selectedCandidate = candidates.find((candidate) => candidate.name === selectedMatchName);
      if (!selectedCandidate?.matchedId) return;
      onSaveRemap(entity.key, {
        id: selectedCandidate.matchedId,
        name: selectedCandidate.name,
        isNew: false,
      });
    } else {
      onSaveRemap(entity.key, {
        id: null,
        name: customNewName.trim() || entity.name,
        isNew: true,
      });
    }
    onClose();
  }

  const kindIcon =
    entity.tab === "asset"
      ? Layers
      : entity.tab === "fund"
        ? Building2
        : entity.tab === "investor"
          ? Users
          : Wallet;

  const Icon = kindIcon;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <DialogHeader className="border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/10 text-primary">
              <Icon className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-sm font-semibold">
                Change Match / Remap {entity.tab.toUpperCase()}
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Current record: <strong className="text-foreground">{entity.name}</strong> ({entity.code})
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="p-5 space-y-4 text-xs">
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as "existing" | "new")}
            className="grid grid-cols-2 gap-3"
          >
            <div className="flex items-center space-x-2 rounded-lg border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
              <RadioGroupItem value="existing" id="remap-existing" />
              <Label htmlFor="remap-existing" className="cursor-pointer text-xs font-medium">
                Match to Existing
              </Label>
            </div>
            <div className="flex items-center space-x-2 rounded-lg border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
              <RadioGroupItem value="new" id="remap-new" />
              <Label htmlFor="remap-new" className="cursor-pointer text-xs font-medium">
                Stage as New Record
              </Label>
            </div>
          </RadioGroup>

          {mode === "existing" ? (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Select workspace record to match:</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search existing records..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-8 text-xs bg-muted/20"
                />
              </div>

              <div className="max-h-48 overflow-y-auto rounded-md border divide-y text-xs">
                {filteredCandidates.length === 0 ? (
                  <div className="p-3 text-center text-muted-foreground">
                    {candidates.length === 0 ? "No other records found in this category." : "No matching records found."}
                  </div>
                ) : (
                  filteredCandidates.map((c) => {
                    const isSelected = selectedMatchName === c.name;
                    return (
                      <div
                        key={c.key}
                        onClick={() => setSelectedMatchName(c.name)}
                        className={`flex items-center justify-between p-2.5 cursor-pointer hover:bg-muted/50 transition-colors ${
                          isSelected ? "bg-primary/10 font-medium text-primary" : ""
                        }`}
                      >
                        <span className="truncate">{c.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {c.code}
                        </Badge>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">New Record Name:</Label>
              <Input
                value={customNewName}
                onChange={(e) => setCustomNewName(e.target.value)}
                placeholder="Enter entity name"
                className="h-8 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                This record will be staged in memory and created as a new database record when approved.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="border-t px-5 py-3 bg-muted/20">
          <Button variant="outline" size="sm" onClick={onClose} className="h-8 text-xs">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={mode === "existing" && !candidates.some((candidate) => candidate.name === selectedMatchName)}
            className="h-8 text-xs"
          >
            Apply Remap
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
