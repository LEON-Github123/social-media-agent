import { z } from "zod";
import { SocialContentStore } from "./social-store.js";
import { JobConflictError } from "./store-errors.js";
import {
  editorialFeedbackTags,
  type EditorialDashboard,
  type EditorialFeedback,
  type EditorialPreferences,
} from "./editorial-types.js";
import type { SocialCandidateState, XPostSnapshot } from "./social-types.js";

const DAY = 86_400_000;
const brandKey = z.string().trim().min(1).max(200);
const candidateKey = z.string().trim().min(1).max(200);
const feedbackInput = z
  .object({
    brandId: brandKey,
    candidateId: candidateKey,
    tag: z.enum(editorialFeedbackTags),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
const preferencesInput = z
  .object({
    brandId: brandKey,
    expectedVersion: z.number().int().nonnegative(),
    selectionGuidance: z.string().trim().max(1200),
    writingGuidance: z.string().trim().max(1200),
    examples: z.array(z.string().trim().min(1).max(600)).max(3),
    confirmed: z.literal(true),
  })
  .strict();
const snoozeInput = z
  .object({
    brandId: brandKey,
    candidateId: candidateKey,
    days: z.union([z.literal(1), z.literal(3)]),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

interface EditorialEvent {
  sequence: number;
  type: string;
  createdAt: number;
  after: Record<string, unknown>;
}

// Shanghai has no DST; shift before taking UTC calendar boundaries.
function shanghaiDay(timestamp: number): number {
  return Math.floor((timestamp + 8 * 3_600_000) / DAY);
}
function metric(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function interactions(snapshot: XPostSnapshot): number | null {
  const values = [
    snapshot.likes,
    snapshot.replies,
    snapshot.reposts,
    snapshot.quotes,
  ].map(metric);
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0);
}
function increased(
  before: number | null,
  after: number | null,
  minimum: number,
): boolean {
  return (
    before !== null &&
    after !== null &&
    after >= before * 1.5 &&
    after - before >= minimum
  );
}

/** Human editorial choices are audit-backed and never reserve generation work. */
export abstract class EditorialContentStore extends SocialContentStore {
  private editorialEvents(brandId: string): EditorialEvent[] {
    return this.db
      .prepare(
        "SELECT rowid AS sequence,event_type,created_at,after_json FROM audit_events WHERE brand_id=? AND (event_type LIKE 'editorial.%' OR event_type='social.held') ORDER BY rowid",
      )
      .all(brandKey.parse(brandId))
      .map((row) => ({
        sequence: Number(row.sequence),
        type: String(row.event_type),
        createdAt: Number(row.created_at),
        after: row.after_json ? JSON.parse(String(row.after_json)) : {},
      }));
  }

  private editorialCandidate(brandId: string, candidateId: string) {
    brandKey.parse(brandId);
    candidateKey.parse(candidateId);
    const candidate = this.getCandidate(candidateId);
    if (
      !candidate ||
      candidate.brandId !== brandId ||
      candidate.origin !== "twitterapi-user"
    )
      throw new JobConflictError("编辑操作必须使用本品牌的社媒素材");
    return candidate;
  }

  private preferencesFromEvents(
    events: EditorialEvent[],
  ): EditorialPreferences {
    const saved = events.filter(
      (event) => event.type === "editorial.preferences",
    );
    const latest = saved[saved.length - 1];
    if (!latest)
      return {
        version: 0,
        selectionGuidance: "",
        writingGuidance: "",
        examples: [],
      };
    return latest.after as unknown as EditorialPreferences;
  }

  getEditorialPreferences(brandId: string): EditorialPreferences {
    return this.preferencesFromEvents(this.editorialEvents(brandId));
  }

  getEditorialDashboard(brandId: string): EditorialDashboard {
    const events = this.editorialEvents(brandId);
    const feedback = new Map<string, EditorialFeedback>();
    for (const event of events) {
      if (event.type === "editorial.feedback") {
        const item = event.after as unknown as EditorialFeedback;
        feedback.set(item.candidateId, item);
      }
    }
    const tagCounts = Object.fromEntries(
      editorialFeedbackTags.map((tag) => [tag, 0]),
    ) as EditorialDashboard["feedbackSummary"]["tagCounts"];
    for (const item of feedback.values()) tagCounts[item.tag]++;
    const suggestions: string[] = [];
    if (feedback.size < 20)
      suggestions.push(
        `样本 ${feedback.size}/20，建议继续标记；当前仅为人工整理提示，不代表已验证效果。`,
      );
    if (tagCounts.useful_topic)
      suggestions.push("优先保留已标记有用选题的受众需求与具体问题。");
    if (tagCounts.good_expression)
      suggestions.push("将认可的表达整理为写作示例，保留清晰、具体的措辞。");
    if (tagCounts.product_demo)
      suggestions.push("适当增加产品演示与实际使用步骤，并核对品牌事实。");
    if (tagCounts.too_broad)
      suggestions.push("缩小选题范围，围绕一个明确场景展开。");
    if (tagCounts.not_relevant)
      suggestions.push("明确受众和业务关联，减少不相关话题。");
    if (tagCounts.repetitive)
      suggestions.push("减少重复主题，优先新的问题和表达角度。");
    return {
      profile: this.preferencesFromEvents(events),
      feedbackSummary: {
        uniqueCandidates: feedback.size,
        tagCounts,
        suggestions,
      },
    };
  }

  recordEditorialFeedback(input: {
    brandId: string;
    candidateId: string;
    tag: EditorialFeedback["tag"];
    note?: string;
  }): EditorialFeedback {
    const value = feedbackInput.parse(input);
    return this.transaction(() => {
      this.editorialCandidate(value.brandId, value.candidateId);
      const feedback: EditorialFeedback = {
        candidateId: value.candidateId,
        tag: value.tag,
        note: value.note || null,
        createdAt: this.now(),
      };
      this.recordAudit({
        brandId: value.brandId,
        eventType: "editorial.feedback",
        reason: "人工素材偏好反馈",
        after: feedback,
      });
      return feedback;
    });
  }

  saveEditorialPreferences(input: {
    brandId: string;
    expectedVersion: number;
    selectionGuidance: string;
    writingGuidance: string;
    examples: string[];
    confirmed: true;
  }): EditorialPreferences {
    const value = preferencesInput.parse(input);
    return this.transaction(() => {
      const before = this.getEditorialPreferences(value.brandId);
      if (before.version !== value.expectedVersion)
        throw new JobConflictError("偏好已更新，请重新加载后确认");
      const profile: EditorialPreferences = {
        version: before.version + 1,
        selectionGuidance: value.selectionGuidance,
        writingGuidance: value.writingGuidance,
        examples: value.examples,
      };
      this.recordAudit({
        brandId: value.brandId,
        eventType: "editorial.preferences",
        reason: "人工确认应用编辑偏好",
        before,
        after: profile,
      });
      return profile;
    });
  }

  markEditorialSeen(
    brandId: string,
    candidateId: string,
  ): { candidateId: string; seenAt: number } {
    return this.transaction(() => {
      this.editorialCandidate(brandId, candidateId);
      const previous = this.editorialEvents(brandId).find(
        (event) =>
          event.type === "editorial.seen" &&
          event.after.candidateId === candidateId,
      );
      if (previous)
        return { candidateId, seenAt: Number(previous.after.seenAt) };
      const seen = { candidateId, seenAt: this.now() };
      this.recordAudit({
        brandId,
        eventType: "editorial.seen",
        reason: "人工标记已浏览",
        after: seen,
      });
      return seen;
    });
  }

  snoozeEditorialCandidate(input: {
    brandId: string;
    candidateId: string;
    days: 1 | 3;
    reason: string;
  }): { candidateId: string; snoozedUntil: number } {
    const value = snoozeInput.parse(input);
    return this.transaction(() => {
      const candidate = this.editorialCandidate(
        value.brandId,
        value.candidateId,
      );
      if (candidate.status === "rejected")
        throw new JobConflictError("已拒绝素材不能暂缓");
      this.holdSocialCandidate(
        value.brandId,
        value.candidateId,
        true,
        value.reason,
      );
      const events = this.editorialEvents(value.brandId);
      const hold = events[events.length - 1];
      const snooze = {
        candidateId: value.candidateId,
        snoozedUntil: (shanghaiDay(this.now()) + value.days) * DAY + 3_600_000,
      };
      this.recordAudit({
        brandId: value.brandId,
        eventType: "editorial.snoozed",
        reason: value.reason,
        after: { ...snooze, heldSequence: hold.sequence },
      });
      return snooze;
    });
  }

  private activeSnoozes(events: EditorialEvent[]): Map<string, EditorialEvent> {
    const snoozes = new Map<string, EditorialEvent>();
    const holds = new Map<string, EditorialEvent>();
    for (const event of events) {
      const id = String(event.after.candidateId ?? "");
      if (event.type === "editorial.snoozed") snoozes.set(id, event);
      if (event.type === "social.held") holds.set(id, event);
    }
    for (const [id, event] of snoozes) {
      const hold = holds.get(id);
      if (
        !hold ||
        hold.sequence !== event.after.heldSequence ||
        hold.after.held !== true
      )
        snoozes.delete(id);
    }
    return snoozes;
  }

  /** Called only by a background tick; reads never release a hold. */
  resumeDueEditorialSnoozes(brandId: string): string[] {
    return this.transaction(() => {
      const resumed: string[] = [];
      for (const [id, event] of this.activeSnoozes(
        this.editorialEvents(brandId),
      )) {
        if (Number(event.after.snoozedUntil) > this.now()) continue;
        const candidate = this.getCandidate(id);
        const row = this.db
          .prepare("SELECT held FROM social_candidates WHERE candidate_id=?")
          .get(id);
        if (
          !candidate ||
          candidate.brandId !== brandId ||
          candidate.origin !== "twitterapi-user" ||
          candidate.status === "rejected" ||
          this.isSocialProtected(candidate) ||
          !row?.held
        )
          continue;
        this.holdSocialCandidate(
          brandId,
          id,
          false,
          "人工暂缓到期，恢复候选展示",
        );
        this.recordAudit({
          brandId,
          eventType: "editorial.resumed",
          actor: "editorial-tick",
          reason: "人工暂缓到期",
          after: { candidateId: id, snoozedUntil: event.after.snoozedUntil },
        });
        resumed.push(id);
      }
      return resumed;
    });
  }

  protected override orderSocialStates(
    brandId: string,
    states: SocialCandidateState[],
  ): void {
    const events = this.editorialEvents(brandId);
    const seen = new Map<string, number>();
    for (const event of events)
      if (event.type === "editorial.seen")
        seen.set(String(event.after.candidateId), Number(event.after.seenAt));
    const snoozes = this.activeSnoozes(events);
    const firstSeen = new Map(
      this.db
        .prepare(
          "SELECT id,created_at FROM content_candidates WHERE brand_id=? AND origin='twitterapi-user'",
        )
        .all(brandId)
        .map((row) => [String(row.id), Number(row.created_at)]),
    );
    const today = shanghaiDay(this.now());
    const yesterday = new Map<string, XPostSnapshot>();
    for (const row of this.db
      .prepare(
        "SELECT candidate_id,snapshot_json FROM social_observations WHERE brand_id=? AND observed_at>=? AND observed_at<? ORDER BY observed_at",
      )
      .all(
        brandId,
        (today - 1) * DAY - 8 * 3_600_000,
        today * DAY - 8 * 3_600_000,
      )) {
      yesterday.set(
        String(row.candidate_id),
        JSON.parse(String(row.snapshot_json)),
      );
    }
    for (const state of states) {
      const firstSeenAt = firstSeen.get(state.candidateId)!;
      const seenAt = seen.get(state.candidateId) ?? null;
      const previous = yesterday.get(state.candidateId);
      const current = state.social;
      const fresh = shanghaiDay(firstSeenAt) === today && seenAt === null;
      const rising = Boolean(
        current &&
        previous &&
        shanghaiDay(current.observedAt) === today &&
        (increased(metric(previous.views), metric(current.views), 100) ||
          increased(interactions(previous), interactions(current), 10)),
      );
      state.editorial = {
        firstSeenAt,
        seenAt,
        snoozedUntil: state.held
          ? Number(snoozes.get(state.candidateId)?.after.snoozedUntil) || null
          : null,
        bucket: fresh ? "new" : rising ? "rising" : "backlog",
        reason: fresh
          ? "今天首次发现，尚未标记已浏览"
          : rising
            ? "较昨日最近观测，浏览量或互动量增长至少 50% 且达到增量门槛；仅代表指标变化，不代表转化"
            : "此前发现或已浏览，等待人工处理",
        waitingDays: Math.max(0, today - shanghaiDay(firstSeenAt)),
      };
    }
    const rank = { new: 0, rising: 1, backlog: 2 };
    states.sort(
      (a, b) =>
        rank[a.editorial!.bucket] - rank[b.editorial!.bucket] ||
        (b.score ?? -1) - (a.score ?? -1) ||
        a.candidateId.localeCompare(b.candidateId),
    );
  }
}
