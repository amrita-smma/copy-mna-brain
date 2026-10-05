"use client";

import Pipeline from "@/views/Pipeline";

/**
 * The Sourcing page: deals not yet in L0 — the inbound Pending Confirmation
 * bucket and AI Market Scanning. It runs on the Pipeline view so the pending
 * table keeps the same row actions, triage and dialogs as the pipeline table.
 */
export default function Sourcing() {
  return <Pipeline page="sourcing" />;
}
