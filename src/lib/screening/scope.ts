import { UNREVIEWED_STAGE } from '@/lib/constants';
import { FIRST_STAGE_KEY } from '@/lib/pipeline/stages';

/**
 * Stages whose screenings the Pipeline's AI Screening panel lists: Pending
 * Confirmation (Scan now / Auto-scan / row Run AI Screening) and L0 (results
 * carried forward after promote). Only active — not dropped — companies.
 */
export const SCREENING_PANEL_STAGES: readonly string[] = [UNREVIEWED_STAGE, FIRST_STAGE_KEY];
