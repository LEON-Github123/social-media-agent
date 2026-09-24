/** Pure DTOs shared by the selector, persistence layer and operations CLI. */
export type TopicEventType =
  | "release"
  | "api_change"
  | "pricing_change"
  | "benchmark"
  | "tutorial"
  | "incident"
  | "other";

export interface CandidateSelectionInput {
  id: string;
  url: string;
  title?: string;
  text: string;
  publishedAt?: string;
  firstSeenAt: number;
  sourceType?: string;
  /** Declared by trusted source configuration, never awarded by the model. */
  primary: boolean;
}

export interface TopicIdentity {
  entity: string;
  product: string;
  version: string | null;
  eventType: TopicEventType;
  eventDate: string | null;
  primaryUrl: string | null;
}

export interface SelectionScores {
  relevance: number;
  evidence: number;
  /** Deterministic publication age score; unknown dates stay null. */
  freshness: number | null;
  developerValue: number;
}

export interface TopicSourceMetadata {
  candidateId: string;
  url: string;
  primary: boolean;
  publishedAt?: string;
  totalScore?: number;
}

export interface ExistingTopic {
  id: string;
  identity: TopicIdentity;
  sourceCandidateIds: string[];
  sourceUrls: string[];
  /** True even if the existing writing job has not published yet. */
  hasContent: boolean;
  sourceMetadata?: TopicSourceMetadata[];
  /** Unresolved historical references; these are not an approved binding. */
  conflictingTopicIds?: string[];
}

export interface SelectionCandidateDecision {
  candidateId: string;
  status: "selected" | "rejected" | "needs_review";
  scores: SelectionScores;
  totalScore: number;
  reason: string;
  identity: TopicIdentity | null;
  topicId?: string;
}

export interface SelectedTopic {
  id: string;
  /** Versioned deterministic identity key; existing IDs remain authoritative. */
  identityKey: string;
  title: string;
  identity: TopicIdentity;
  /** Newly assessed candidates; each occurs in at most one topic. */
  candidateIds: string[];
  /** Includes retained historical sources; never more than eight. */
  sourceCandidateIds: string[];
  sourceMetadata: TopicSourceMetadata[];
  status: "ready" | "needs_review" | "existing";
  reason: string;
  existingTopicId?: string;
  /** Historical identity conflicts must be resolved without creating another job. */
  conflictingTopicIds?: string[];
}

export interface SelectionResult {
  candidateDecisions: SelectionCandidateDecision[];
  topics: SelectedTopic[];
  /** Attempted model invocations. The caller persists/reserves call budgets. */
  modelCalls: 0 | 1 | 2;
  warnings: string[];
}

export interface SelectionThresholds {
  minimumTotalScore?: number;
  minimumRelevance?: number;
  minimumEvidence?: number;
  minimumDeveloperValue?: number;
  maxNewsAgeDays?: number;
}
