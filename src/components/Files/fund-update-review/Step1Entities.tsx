"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Check, RefreshCw, Layers, Building2, Users, Wallet } from "lucide-react";
import type { EntityTabKind, ReviewEntity } from "./types";
import { RemapModal } from "./RemapModal";
import { useFeatureEnabled } from "@/components/layout/FeatureFlagsContext";
import { cn } from "@/lib/utils";

interface Step1EntitiesProps {
  entities: ReviewEntity[];
  activeTab: EntityTabKind;
  onTabChange: (tab: EntityTabKind) => void;
  selectedEntityKey: string | null;
  onSelectEntity: (key: string) => void;
  onToggleStaged: (key: string, staged: boolean) => void;
  onToggleAllInTab: (tab: EntityTabKind, staged: boolean) => void;
  onSaveRemap: (entityKey: string, remapped: { id: string | null; name: string; isNew: boolean }) => void;
  readOnly?: boolean;
}

const TAB_CONFIG: Array<{ k: EntityTabKind; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { k: "asset", label: "Asset", icon: Layers },
  { k: "fund", label: "Fund", icon: Building2 },
  { k: "investor", label: "Investor", icon: Users },
  { k: "source", label: "Source of Fund", icon: Wallet },
];

export function Step1Entities({
  entities,
  activeTab: requestedTab,
  onTabChange,
  selectedEntityKey,
  onSelectEntity,
  onToggleStaged,
  onToggleAllInTab,
  onSaveRemap,
  readOnly = false,
}: Step1EntitiesProps) {
  const [search, setSearch] = useState("");
  const [remapModalEntity, setRemapModalEntity] = useState<ReviewEntity | null>(null);

  // Fund vehicles are hidden entirely when the workspace has the Fund Vehicle
  // View feature off — same rule the Fund Management portfolio tabs follow.
  const fundVehicleViewEnabled = useFeatureEnabled("FUND_VEHICLE_VIEW_ENABLED");
  const visibleTabs = useMemo(
    () => TAB_CONFIG.filter((t) => fundVehicleViewEnabled || t.k !== "fund"),
    [fundVehicleViewEnabled],
  );
  const activeTab: EntityTabKind =
    !fundVehicleViewEnabled && requestedTab === "fund" ? "asset" : requestedTab;
  useEffect(() => {
    if (activeTab !== requestedTab) {
      onTabChange(activeTab);
    }
  }, [activeTab, requestedTab, onTabChange]);

  // Entities filtered by tab
  const listInTab = useMemo(
    () => entities.filter((e) => e.tab === activeTab),
    [entities, activeTab],
  );

  // Entities filtered by search query
  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return listInTab;
    return listInTab.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.englishName?.toLowerCase().includes(q) ||
        e.code.toLowerCase().includes(q) ||
        e.fields.some((f) => String(f.value ?? "").toLowerCase().includes(q)),
    );
  }, [listInTab, search]);

  // Counts of new / total per tab
  const tabCounts = useMemo(() => {
    const counts: Record<EntityTabKind, { total: number; newCount: number }> = {
      asset: { total: 0, newCount: 0 },
      fund: { total: 0, newCount: 0 },
      investor: { total: 0, newCount: 0 },
      source: { total: 0, newCount: 0 },
    };
    for (const e of entities) {
      counts[e.tab].total += 1;
      if (e.status === "new") counts[e.tab].newCount += 1;
    }
    return counts;
  }, [entities]);

  // Selection counts in current tab
  const newInCurrentTab = useMemo(
    () => listInTab.filter((e) => e.status === "new"),
    [listInTab],
  );
  const stagedNewCount = useMemo(
    () => newInCurrentTab.filter((e) => e.isStaged).length,
    [newInCurrentTab],
  );

  const allNewChecked = newInCurrentTab.length > 0 && stagedNewCount === newInCurrentTab.length;
  const someNewChecked = stagedNewCount > 0 && stagedNewCount < newInCurrentTab.length;

  // Active entity for detail pane
  const activeEntity = useMemo(() => {
    if (selectedEntityKey) {
      const found = filteredList.find((e) => e.key === selectedEntityKey) || listInTab.find((e) => e.key === selectedEntityKey);
      if (found) return found;
    }
    return filteredList[0] || listInTab[0] || null;
  }, [selectedEntityKey, filteredList, listInTab]);

  const renderEntityItem = (e: ReviewEntity, isNested = false) => {
    const isActive = activeEntity?.key === e.key;
    const isNew = e.status === "new";
    const englishName = e.englishName?.trim();
    const hasDistinctEnglishName =
      Boolean(englishName) &&
      englishName!.toLocaleLowerCase() !== e.name.trim().toLocaleLowerCase();

    return (
      <div
        key={e.key}
        role="button"
        tabIndex={0}
        onClick={() => onSelectEntity(e.key)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onSelectEntity(e.key);
          }
        }}
        className={cn(
          "flex w-full cursor-pointer items-start gap-2.5 p-3 text-left transition-colors hover:bg-muted/50",
          isNested && "pl-7",
          isActive && "bg-primary/5 dark:bg-primary/10 border-l-2 border-primary",
        )}
      >
        {!readOnly ? (
          isNew ? (
            <Checkbox
              checked={e.isStaged}
              onCheckedChange={(v) => onToggleStaged(e.key, Boolean(v))}
              onClick={(ev) => ev.stopPropagation()}
              className="mt-0.5"
              aria-label={`Stage ${e.name}`}
            />
          ) : (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-emerald-600 dark:text-emerald-400">
              <Check className="h-3 w-3 stroke-[3]" />
            </span>
          )
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1.5">
            <span className="text-xs font-semibold text-foreground truncate" title={e.name}>
              {e.name}
            </span>
            <Badge
              variant={isNew ? "default" : "outline"}
              className={cn(
                "text-[10px] px-1.5 py-0",
                isNew
                  ? "bg-primary/15 text-primary hover:bg-primary/20 border-primary/20"
                  : "border-border text-muted-foreground",
              )}
            >
              {isNew ? "New" : "Matched"}
            </Badge>
          </div>
          {hasDistinctEnglishName ? (
            <div className="truncate text-[11px] text-muted-foreground mt-0.5" title={englishName}>
              {englishName}
            </div>
          ) : null}
          <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <span>{e.txnsCount} txns</span>
            <span>·</span>
            <span>{e.valsCount} vals</span>
          </div>
        </div>
      </div>
    );
  };

  const renderGroupHeaderRow = (groupEntity: ReviewEntity, memberCount: number) => {
    const isActive = activeEntity?.key === groupEntity.key;
    const isNew = groupEntity.status === "new";

    return (
      <div
        key={groupEntity.key}
        role="button"
        tabIndex={0}
        onClick={() => onSelectEntity(groupEntity.key)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onSelectEntity(groupEntity.key);
          }
        }}
        className={cn(
          "flex w-full cursor-pointer items-center justify-between gap-2.5 px-3.5 py-2.5 text-left transition-colors bg-muted border-b border-border hover:bg-muted/80",
          isActive && "ring-1 ring-inset ring-primary border-l-2 border-l-primary",
        )}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {!readOnly ? (
            isNew ? (
              <Checkbox
                checked={groupEntity.isStaged}
                onCheckedChange={(v) => onToggleStaged(groupEntity.key, Boolean(v))}
                onClick={(ev) => ev.stopPropagation()}
                className="shrink-0"
                aria-label={`Stage ${groupEntity.name}`}
              />
            ) : (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-emerald-600 dark:text-emerald-400">
                <Check className="h-3 w-3 stroke-[3]" />
              </span>
            )
          ) : null}
          <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground truncate" title={groupEntity.name}>
            {groupEntity.name}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-muted-foreground">
            {memberCount} {memberCount === 1 ? "entity" : "entities"}
          </span>
          <Badge
            variant={isNew ? "default" : "outline"}
            className={cn(
              "text-[10px] px-1.5 py-0",
              isNew
                ? "bg-primary/15 text-primary hover:bg-primary/20 border-primary/20"
                : "border-border text-muted-foreground",
            )}
          >
            {isNew ? "New" : "Matched"}
          </Badge>
        </div>
      </div>
    );
  };

  const renderAssetGroupHeader = (groupName: string, count: number) => {
    return (
      <div
        key={`asset-group-header-${groupName}`}
        className="flex w-full items-center justify-between gap-2.5 px-3.5 py-2.5 text-left bg-muted border-b border-border"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground truncate" title={groupName}>
            {groupName}
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground shrink-0">
          {count} {count === 1 ? "asset" : "assets"}
        </span>
      </div>
    );
  };

  // Grouping (investor groups / asset-by-fund sections) only makes sense when the
  // workspace models parent groups instead of fund vehicles. With Fund Vehicle View
  // on, funds are first-class records and the lists render flat.
  const investorSections = useMemo(() => {
    if (fundVehicleViewEnabled) return null;
    if (activeTab !== "investor") return null;

    const groupEntities = listInTab.filter((e) => e.isGroup);
    const memberEntities = listInTab.filter((e) => !e.isGroup);

    const filteredKeySet = new Set(filteredList.map((e) => e.key));
    const assignedMemberKeys = new Set<string>();

    const sections: Array<{
      group: ReviewEntity;
      members: ReviewEntity[];
    }> = [];

    for (const g of groupEntities) {
      const gNameLower = g.name.trim().toLowerCase();
      const allGroupMembers = memberEntities.filter(
        (m) => m.groupName && m.groupName.trim().toLowerCase() === gNameLower,
      );
      allGroupMembers.forEach((m) => assignedMemberKeys.add(m.key));

      const matchingMembers = allGroupMembers.filter((m) => filteredKeySet.has(m.key));
      const groupMatches = filteredKeySet.has(g.key);

      if (groupMatches || matchingMembers.length > 0) {
        sections.push({
          group: g,
          members: search.trim() ? matchingMembers : allGroupMembers,
        });
      }
    }

    const allUngrouped = memberEntities.filter((m) => !assignedMemberKeys.has(m.key));
    const matchingUngrouped = allUngrouped.filter((m) => filteredKeySet.has(m.key));

    return {
      sections,
      ungrouped: search.trim() ? matchingUngrouped : allUngrouped,
    };
  }, [fundVehicleViewEnabled, activeTab, listInTab, filteredList, search]);

  const assetSections = useMemo(() => {
    if (fundVehicleViewEnabled) return null;
    if (activeTab !== "asset") return null;

    const filteredKeySet = new Set(filteredList.map((e) => e.key));
    const groupsMap = new Map<string, ReviewEntity[]>();
    const ungrouped: ReviewEntity[] = [];

    for (const a of listInTab) {
      if (!filteredKeySet.has(a.key)) continue;
      const gName = a.groupName?.trim();
      if (gName) {
        const list = groupsMap.get(gName) ?? [];
        list.push(a);
        groupsMap.set(gName, list);
      } else {
        ungrouped.push(a);
      }
    }

    const sections = Array.from(groupsMap.entries()).map(([groupName, items]) => ({
      groupName,
      items,
    }));

    return {
      sections,
      ungrouped,
    };
  }, [fundVehicleViewEnabled, activeTab, listInTab, filteredList]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Top bar with tabs & stats */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-2.5 bg-muted/20">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-full border border-border bg-muted/40 p-0.5">
            {visibleTabs.map(({ k, label }) => {
              const count = tabCounts[k];
              const isActive = activeTab === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    onTabChange(k);
                    setSearch("");
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span>{label}</span>
                  {count.newCount > 0 && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.2 text-[10px]",
                        isActive ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {count.newCount} new
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Search filter */}
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${TAB_CONFIG.find((t) => t.k === activeTab)?.label.toLowerCase()}s...`}
            className="h-8 pl-8 text-xs bg-background"
          />
        </div>
      </div>

      {/* Split layout: List on Left, Detail on Right */}
      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr] overflow-hidden">
        {/* Left List Pane */}
        <div className="flex min-h-0 flex-col border-r border-border bg-muted/10">
          {/* Header with select all */}
          {!readOnly && (
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={allNewChecked ? true : someNewChecked ? "indeterminate" : false}
                  disabled={newInCurrentTab.length === 0}
                  onCheckedChange={(c) => onToggleAllInTab(activeTab, Boolean(c))}
                  aria-label="Select all new entities"
                />
                <span>
                  {stagedNewCount} of {newInCurrentTab.length} new selected
                </span>
              </div>
              <span className="text-[11px]">
                {listInTab.length - newInCurrentTab.length} matched
              </span>
            </div>
          )}

          {/* List items */}
          <div className="flex-1 overflow-y-auto divide-y divide-border/60">
            {filteredList.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                No {TAB_CONFIG.find((t) => t.k === activeTab)?.label.toLowerCase()} records found.
              </div>
            ) : activeTab === "investor" && investorSections ? (
              <>
                {investorSections.sections.map(({ group, members }) => (
                  <div key={group.key} className="border-b border-border/60 last:border-b-0">
                    {renderGroupHeaderRow(group, members.length)}
                    <div className="divide-y divide-border/40">
                      {members.map((m) => renderEntityItem(m, true))}
                    </div>
                  </div>
                ))}
                {investorSections.ungrouped.length > 0 && (
                  <div key="ungrouped-investors" className="border-b border-border/60 last:border-b-0">
                    <div className="flex w-full items-center justify-between gap-2.5 px-3.5 py-2 text-left bg-muted border-b border-border">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Ungrouped
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {investorSections.ungrouped.length} {investorSections.ungrouped.length === 1 ? "entity" : "entities"}
                      </span>
                    </div>
                    <div className="divide-y divide-border/40">
                      {investorSections.ungrouped.map((m) => renderEntityItem(m, true))}
                    </div>
                  </div>
                )}
              </>
            ) : activeTab === "asset" && assetSections ? (
              <>
                {assetSections.sections.map(({ groupName, items }) => (
                  <div key={groupName} className="border-b border-border/60 last:border-b-0">
                    {renderAssetGroupHeader(groupName, items.length)}
                    <div className="divide-y divide-border/40">
                      {items.map((a) => renderEntityItem(a, true))}
                    </div>
                  </div>
                ))}
                {assetSections.ungrouped.length > 0 && (
                  <div key="ungrouped-assets" className="border-b border-border/60 last:border-b-0">
                    <div className="flex w-full items-center justify-between gap-2.5 px-3.5 py-2 text-left bg-muted border-b border-border">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Ungrouped
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {assetSections.ungrouped.length} {assetSections.ungrouped.length === 1 ? "asset" : "assets"}
                      </span>
                    </div>
                    <div className="divide-y divide-border/40">
                      {assetSections.ungrouped.map((a) => renderEntityItem(a, true))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              filteredList.map((e) => renderEntityItem(e, false))
            )}
          </div>
        </div>

        {/* Right Detail Pane */}
        <div className="flex min-h-0 flex-col overflow-y-auto p-6 bg-background">
          {activeEntity ? (
            <div className="space-y-6 max-w-3xl">
              {/* Entity Title & Status Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-lg font-semibold text-foreground">{activeEntity.name}</h3>
                  <Badge
                    variant={activeEntity.status === "new" ? "default" : "outline"}
                    className={cn(
                      "text-xs",
                      activeEntity.status === "new"
                        ? "bg-primary/15 text-primary border-primary/30"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    )}
                  >
                    {activeEntity.status === "new" ? "New record" : "Matched to existing record"}
                  </Badge>
                  {activeEntity.englishName ? (
                    <Badge variant="outline" className="text-xs">
                      {activeEntity.englishName}
                    </Badge>
                  ) : null}
                </div>

                {!readOnly && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRemapModalEntity(activeEntity)}
                    className="h-8 gap-1.5 text-xs"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Change match / Remap
                  </Button>
                )}
              </div>

              {/* Attributes Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border border-border bg-muted/20 p-4 text-xs">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    English Name
                  </div>
                  <div className="text-sm font-medium text-foreground mt-0.5">
                    {activeEntity.englishName || "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Name
                  </div>
                  <div className="text-sm font-medium text-foreground mt-0.5">
                    {activeEntity.name}
                  </div>
                </div>

                {activeEntity.fields.map((f, i) => (
                  <div key={i}>
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {f.label}
                    </div>
                    <div className="text-sm text-foreground mt-0.5">
                      {String(f.value || "—")}
                    </div>
                  </div>
                ))}
              </div>

              {/* Related Records Links */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Related Records
                </h4>
                {activeEntity.links.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No related records linked.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {activeEntity.links.map((link, idx) => (
                      <div
                        key={idx}
                        className="rounded-lg border border-border bg-card p-3 shadow-xs space-y-1"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                            {link.kind}
                          </span>
                          <Badge
                            variant={link.status === "new" ? "default" : "outline"}
                            className={cn(
                              "text-[10px]",
                              link.status === "new"
                                ? "bg-primary/15 text-primary border-primary/20"
                                : "text-muted-foreground",
                            )}
                          >
                            {link.status === "new" ? "New" : "Matched"}
                          </Badge>
                        </div>
                        <div className="font-medium text-foreground text-xs truncate">
                          {link.name}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {link.status === "new" ? "Will be created on approval" : "Already in workspace database"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Explanatory note */}
              {activeEntity.status === "new" ? (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3.5 text-xs text-primary/90">
                  <strong>Staging in-memory:</strong> This record has not been written to the database yet. It is held in memory and will be created when you approve Step 2.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              Select a record on the left to view details.
            </div>
          )}
        </div>
      </div>

      {/* Remap / Change match modal */}
      {remapModalEntity && (
        <RemapModal
          open={Boolean(remapModalEntity)}
          onClose={() => setRemapModalEntity(null)}
          entity={remapModalEntity}
          allEntities={entities}
          onSaveRemap={onSaveRemap}
        />
      )}
    </div>
  );
}
