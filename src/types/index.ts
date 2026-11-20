export type Role = 'OWNER' | 'REVIEWER' | 'INCOMING_MEMBER';

export type ClaimType =
  | 'DECISION'
  | 'TASK'
  | 'OWNER'
  | 'RISK'
  | 'DEPENDENCY'
  | 'BLOCKER'
  | 'NEXT_ACTION'
  | 'OPEN_QUESTION'
  | 'RECURRING_PROBLEM'
  | 'CONTACT_OR_RESOURCE';

export type EvidenceStatus =
  | 'VERIFIED'
  | 'INFERRED'
  | 'CONFLICTING'
  | 'MISSING_EVIDENCE'
  | 'PENDING_REVIEW';

export type ReviewerStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EDITED';

export type SourceType = 'GITHUB' | 'PDF' | 'DOCX' | 'MARKDOWN' | 'TXT' | 'CSV' | 'JSON';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  title: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

export interface AssistantCitation {
  source_id: string;
  source_name: string;
  source_location: string;
  supporting_quote: string;
  claim_id?: string | null;
  exact_verified: boolean;
  match_start_idx: number;
  match_end_idx: number;
}

export interface AssistantResponse {
  answer: string;
  sufficient_evidence: boolean;
  missing_evidence_reason?: string | null;
  confidence: 'high' | 'medium' | 'low';
  citations: AssistantCitation[];
  related_claim_ids: string[];
  suggested_followups: string[];
  accessible_sources_count: number;
  restricted_sources_excluded: number;
  model: string;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  response?: AssistantResponse;
  error?: string;
}

export interface Source {
  id: string;
  project_id: string;
  name: string;
  source_type: SourceType;
  access_level: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL';
  raw_content: string;
  normalized_content: string;
  uploaded_by: string;
  created_at: string;
  updated_at?: string;
  version?: number;
  previous_content?: string;
  processing_status: 'PROCESSED' | 'PENDING' | 'FAILED';
  metadata: {
    repo_url?: string;
    branch?: string;
    commits_count?: number;
    issues_count?: number;
    file_size_bytes?: number;
    lines_count?: number;
    content_hash?: string;
    previous_hash?: string;
    redacted_secrets_count?: number;
  };
}

export interface Claim {
  id: string;
  project_id: string;
  source_id: string;
  source_name: string;
  type: ClaimType;
  statement: string;
  supporting_quote: string;
  source_location: string;
  confidence: 'high' | 'medium' | 'low';
  evidence_status: EvidenceStatus;
  reviewer_status: ReviewerStatus;
  reviewer_decision_notes?: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  owner?: string | null;
  event_date?: string | null;
  reasoning: string;
  exact_quote_match: boolean;
  match_start_idx?: number;
  match_end_idx?: number;
  created_at: string;
  audit_history: {
    timestamp: string;
    action: string;
    actor: string;
    details?: string;
  }[];
}

export interface Conflict {
  id: string;
  project_id: string;
  topic: string;
  claim_a_id: string;
  claim_b_id: string;
  explanation: string;
  status: 'UNRESOLVED' | 'RESOLVED';
  resolution_notes?: string;
  resolved_claim_id?: string;
  resolved_by?: string;
  resolved_at?: string;
}

export interface GapOrMissingEvidence {
  id: string;
  project_id: string;
  title: string;
  description: string;
  category: 'UNASSIGNED_TASK' | 'MISSING_DEPLOY_SPEC' | 'UNKNOWN_DEADLINE' | 'SINGLE_POINT_FAILURE';
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  suggested_action: string;
  source_reference?: string;
}

export interface Handover {
  id: string;
  project_id: string;
  version: string;
  target_role: 'DEVELOPER' | 'PROJECT_MANAGER' | 'STUDENT_INTERN';
  title: string;
  summary: string;
  approved_claims_count: number;
  readiness_score: number;
  created_by: string;
  created_at: string;
  published_at?: string;
  is_published: boolean;
  claims: Claim[];
  acknowledgements: {
    acknowledged_by: string;
    role: string;
    timestamp: string;
    signature_hash: string;
  }[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  members: {
    id: string;
    name: string;
    email: string;
    role: Role;
  }[];
  sources_count: number;
  claims_count: number;
  verified_count: number;
  pending_count: number;
  conflicts_count: number;
  readiness_score: number;
}

export type DependencyNodeType = 'OWNER' | 'DECISION' | 'TASK' | 'DEPENDENCY' | 'BLOCKER' | 'RISK';

export type DependencyEdgeType =
  | 'OWNS'
  | 'BLOCKS'
  | 'DEPENDS_ON'
  | 'AFFECTS'
  | 'CONFLICTS_WITH'
  | 'UNASSIGNED_RISK';

export interface DependencyNode {
  id: string;
  label: string;
  subtitle: string;
  node_type: DependencyNodeType;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  claim_id?: string;
  claim_type?: ClaimType;
  source_id?: string;
  source_name?: string;
  source_location?: string;
  owner?: string | null;
  evidence_status?: EvidenceStatus;
  reviewer_status?: ReviewerStatus;
  statement: string;
  supporting_quote?: string;
  x: number;
  y: number;
}

export interface DependencyEdge {
  id: string;
  from: string;
  to: string;
  relation: DependencyEdgeType;
  label: string;
  reason: string;
  is_critical?: boolean;
}

export interface DependencyGraphResponse {
  project_id: string;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  stats: {
    owners: number;
    decisions: number;
    tasks: number;
    dependencies: number;
    blockers: number;
    risks: number;
    total_edges: number;
  };
}

export type DriftCategory =
  | 'OUTDATED_CLAIM'
  | 'CHANGED_RESPONSIBILITY'
  | 'UNRESOLVED_BLOCKER'
  | 'CONFLICTING_UPDATE'
  | 'CRITICAL_GAP';

export type DriftSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export type DriftAlertStatus = 'OPEN' | 'REVERIFICATION_QUEUED' | 'RESOLVED' | 'DISMISSED';

export interface DriftAlert {
  id: string;
  project_id: string;
  category: DriftCategory;
  severity: DriftSeverity;
  title: string;
  description: string;
  affected_claim_ids: string[];
  affected_source_id?: string;
  affected_source_name?: string;
  previous_evidence: string;
  new_evidence: string;
  recommended_action: string;
  requires_reverification: boolean;
  status: DriftAlertStatus;
  detected_at: string;
  resolved_by?: string;
  resolved_at?: string;
  resolution_note?: string;
}

export interface DriftAnalysisReport {
  project_id: string;
  analyzed_at: string;
  model: string;
  sources_compared: number;
  modified_sources_count: number;
  verified_claims_checked: number;
  alerts: DriftAlert[];
  summary: {
    total_alerts: number;
    open_alerts: number;
    critical_count: number;
    outdated_claims_count: number;
    changed_responsibilities_count: number;
    unresolved_blockers_count: number;
    conflicting_updates_count: number;
    critical_gaps_count: number;
    claims_needing_reverification: string[];
    handover_safe_to_publish: boolean;
  };
}

