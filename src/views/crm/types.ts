export interface PrimaryPic {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
}

export interface TopicChip {
  id: string;
  name: string;
  source: string;
  is_highlight: boolean;
}

export interface TeamMemberSummary {
  id: string;
  name: string;
  email: string | null;
}

export interface EmployerSummary {
  id: string;
  name: string;
  normalized_name: string;
  industry: string | null;
  status: string;
  curation_status: string;
  source: "auto" | "manual";
  created_at: string;
  updated_at: string;
  primary_pic: PrimaryPic | null;
  email_count: number;
  last_contact_at: string | null;
  // Median seconds between an inbound email from this firm and our next reply
  // (null when there are no answered exchanges). response_pair_count is the
  // sample size behind the median.
  response_p50_seconds: number | null;
  response_pair_count: number;
  topics: TopicChip[];
  team: TeamMemberSummary[];
}

export interface Correspondent {
  id: string;
  employer_id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  type: string | null;
  is_primary: boolean;
  source: string;
}

export interface EmployerNote {
  id: string;
  employer_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface EmployerTopicAssignment {
  id: string;
  topic_id: string;
  name: string;
  slug: string;
  source: string;
  is_highlight: boolean;
}

export interface RelatedCompanyEvidence {
  id: string;
  matched_text: string | null;
  reason: string;
  reason_summary: string | null;
  keywords: string[] | null;
  confidence: string;
  created_at: string | null;
  email_id: string | null;
}

export interface EmployerRelatedCompany {
  id: string;
  employer_id: string;
  company_id: string | null;
  company_name: string;
  source: string;
  confidence: string;
  reason: string;
  reason_summary: string | null;
  evidence_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  dismissed_at: string | null;
  evidence: RelatedCompanyEvidence[];
}

export interface EmployerDetail {
  employer: {
    id: string;
    name: string;
    industry: string | null;
    status: string;
  };
  primary_pic: Correspondent | null;
  correspondents: Correspondent[];
  notes: EmployerNote[];
  topics: EmployerTopicAssignment[];
  team: TeamMemberSummary[];
  email_count: number;
  last_contact_at: string | null;
  related_companies: EmployerRelatedCompany[];
}

export interface Insights {
  stale_employers: number;
  flagged_records: number;
  emails_today: number;
  email_accounts: number | null;
  last_synced_at: string | null;
  next_sync_at: string | null;
}

export interface Topic {
  id: string;
  name: string;
  slug: string;
}

export type LastContactPreset =
  | "today"
  | "yesterday"
  | "week"
  | "month"
  | "stale_30"
  | "custom";

export interface FlaggedEmployer {
  id: string;
  name: string;
  industry: string | null;
  status: string;
  primary_pic: {
    id: string;
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

export interface CompanyPickerValue {
  name: string;
  /** Resolved employer id when an existing firm was picked. */
  id?: string;
  /** True when the user opted to create a new firm from typed text. */
  isNew?: boolean;
}
