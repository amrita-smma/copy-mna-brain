"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useColumnManager } from "./useColumnLayout";

interface ColumnConfigGearProps {
  className?: string;
  align?: "start" | "center" | "end";
  /** Accessible label / tooltip for the trigger. */
  label?: string;
  /**
   * When set, the gear is rendered (via a portal) into the element with this
   * id — used to place it inside a parent toolbar/filter row that lives outside
   * this table's provider. Falls back to inline rendering until the node mounts.
   */
  portalTargetId?: string;
}

/**
 * Gear icon → popover listing every managed column (in current display order)
 * with a show/hide checkbox. Visible columns render in the same order shown
 * here. Place it at the top-right of a table's toolbar, or portal it into a
 * parent filter row via `portalTargetId`.
 */
export function ColumnConfigGear<T>({
  className,
  align = "end",
  label = "Configure columns",
  portalTargetId,
}: ColumnConfigGearProps) {
  const mgr = useColumnManager<T>();
  const hiddenCount = mgr.orderedColumns.filter((c) => c.hidden).length;

  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!portalTargetId) return;
    setTarget(document.getElementById(portalTargetId));
  }, [portalTargetId]);

  const gear = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={label}
          title={label}
          className={cn("relative h-8 w-8", className)}
        >
          <Settings2 className="h-4 w-4" />
          {hiddenCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
              {hiddenCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Columns</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => mgr.reset()}
          >
            Reset
          </Button>
        </div>
        <div className="max-h-80 overflow-auto py-1">
          {mgr.orderedColumns.map(({ def, hidden }) => {
            const disabled = def.hideable === false;
            return (
              <label
                key={def.id}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 text-sm",
                  disabled
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:bg-muted",
                )}
              >
                <Checkbox
                  checked={!hidden}
                  disabled={disabled}
                  onCheckedChange={() =>
                    !disabled && mgr.setHidden(def.id, !hidden)
                  }
                />
                <span className="truncate">{def.label}</span>
              </label>
            );
          })}
        </div>
        <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          Drag headers to reorder · shift-click + right-click to group
        </div>
      </PopoverContent>
    </Popover>
  );

  // Portal into the parent toolbar when requested and the target is mounted.
  if (portalTargetId) {
    return target ? createPortal(gear, target) : null;
  }
  return gear;
}
