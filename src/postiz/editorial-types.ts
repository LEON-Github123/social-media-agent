export const editorialFeedbackTags = [
  "useful_topic",
  "good_expression",
  "product_demo",
  "too_broad",
  "not_relevant",
  "repetitive",
] as const;

export type EditorialFeedbackTag = (typeof editorialFeedbackTags)[number];

export interface EditorialPreferences {
  version: number;
  selectionGuidance: string;
  writingGuidance: string;
  examples: string[];
}

export interface EditorialFeedback {
  candidateId: string;
  tag: EditorialFeedbackTag;
  note: string | null;
  createdAt: number;
}

export interface EditorialDashboard {
  profile: EditorialPreferences;
  feedbackSummary: {
    uniqueCandidates: number;
    tagCounts: Record<EditorialFeedbackTag, number>;
    suggestions: string[];
  };
}

export interface EditorialCandidateMetadata {
  firstSeenAt: number;
  seenAt: number | null;
  snoozedUntil: number | null;
  bucket: "new" | "rising" | "backlog";
  reason: string;
  waitingDays: number;
}
