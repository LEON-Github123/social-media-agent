import type {
  CandidateSelectionInput,
  SelectionResult,
} from "./operations-types.js";
import type { EditorialCandidateMetadata } from "./editorial-types.js";

/** Provider observations, never accepted from a manual material request. */
export interface XPostSnapshot {
  tweetId: string;
  authorId: string | null;
  authorHandle: string;
  authorName: string | null;
  postType: "original" | "quote" | "reply" | "repost";
  quotedTweetId: string | null;
  publishedAt: string | null;
  observedAt: number;
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  bookmarks: number | null;
}

export interface SocialMetricSnapshot extends XPostSnapshot {
  candidateId: string;
}

export interface SocialSelectionInput extends CandidateSelectionInput {
  social: XPostSnapshot;
}

export interface SocialPerformance {
  interactions: number | null;
  interactionRate: number | null;
  ageBucket: "under_24h" | "24_72h" | "3_7d" | null;
  viewsScore: number | null;
  interactionsScore: number | null;
  rateScore: number | null;
  accountScore: number | null;
  accountSampleCount: number;
  score: number | null;
  sufficient: boolean;
}

export interface SocialAssessment {
  candidateId: string;
  title: string;
  summary: string;
  reason: string;
  angle: string;
  factGaps: string[];
  relevance: number;
  reusability: number;
  kind: "announcement" | "creative";
  requiresBrandFacts: boolean;
  excludedReason: string | null;
}

export type SelectionFailureCode =
  | "timeout"
  | "rate_limit"
  | "truncated"
  | "invalid_json"
  | "invalid_schema"
  | "coverage"
  | "provider";
export interface SocialSelectionFailure {
  candidateId: string;
  code: SelectionFailureCode;
  message: string;
}
export interface SocialSelectionResult {
  selection: SelectionResult;
  assessments: SocialAssessment[];
  failures: SocialSelectionFailure[];
}

export interface SocialCandidateState {
  candidateId: string;
  social: XPostSnapshot | null;
  assessment: SocialAssessment | null;
  performance: SocialPerformance | null;
  score: number | null;
  tier:
    | "recommended"
    | "watch"
    | "not_recommended"
    | "error"
    | "pending"
    | "history";
  attempts: number;
  errorCode: SelectionFailureCode | null;
  errorMessage: string | null;
  evaluatedAt: number | null;
  held: boolean;
  editorial?: EditorialCandidateMetadata;
  limitReason?: string;
}
