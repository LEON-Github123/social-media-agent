import { randomUUID } from "node:crypto";
import { ContentOperationsStore } from "./operations-store.js";
import { JobConflictError } from "./store-errors.js";
import {
  calculateSocialPerformance,
  selectSocialCandidates,
} from "./social-selector.js";
import type { BrandConfig } from "./content.js";
import type { ContentModel } from "./models.js";
import type { TopicIdentity } from "./operations-types.js";
import { sourceMaterialKey, stableHash } from "./identity.js";
import type { ContentCandidate } from "./operations-store.js";
import type {
  SocialCandidateState,
  SocialAssessment,
  SocialMetricSnapshot,
  SocialSelectionResult,
  XPostSnapshot,
} from "./social-types.js";

const DAY = 86_400_000;
export interface WritingIntent {
  purpose: "brand_original";
  writingAngle?: string;
  writingScope?: "general";
  inspirationRequiresFacts: boolean;
}

export interface SocialRecoveryOptions {
  brand: BrandConfig;
  candidateId: string;
  reason: string;
}
interface RecoveryClaim {
  token: string;
  candidateIds: string[];
  attempts: Record<string, number>;
  leaseUntil: number;
  kind: "retry" | "repair";
  candidateVersions: Record<string, string>;
  topicVersion?: string;
}

/** Durable provider observations and reservations; manual input never writes here. */
export abstract class SocialContentStore extends ContentOperationsStore {
  socialQuotas(brandId: string) {
    const day = this.getGenerationQuota({ brandId, timeZone: "Asia/Shanghai" });
    const provider = Number(
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM social_provider_calls WHERE brand_id=? AND day_key=?",
        )
        .get(brandId, day.dayKey)!.n,
    );
    const selection = Number(
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM selection_model_calls WHERE brand_id=? AND started_at>=? AND started_at<?",
        )
        .get(brandId, day.startsAt, day.resetsAt)!.n,
    );
    return {
      provider: { used: provider, limit: 10 },
      selection: { used: selection, limit: 40 },
      day,
    };
  }

  providerRequests(brandId: string) {
    const { day } = this.socialQuotas(brandId);
    return this.db
      .prepare(
        "SELECT kind,target,tweet_ids_json FROM social_provider_calls WHERE brand_id=? AND day_key=? ORDER BY started_at,id",
      )
      .all(brandId, day.dayKey)
      .map((row) => ({
        kind: String(row.kind),
        target: String(row.target),
        tweetIds: JSON.parse(String(row.tweet_ids_json)) as string[],
      }));
  }

  reserveSocialProviderCall(
    brandId: string,
    kind: "timeline" | "refresh",
    target: string,
    tweetIds: string[] = [],
  ) {
    return this.transaction(() => {
      const { provider, day } = this.socialQuotas(brandId);
      const prior = this.providerRequests(brandId);
      if (provider.used >= provider.limit)
        throw new JobConflictError("今日采集与指标刷新已达 10 次，明天继续");
      if (prior.some((call) => call.kind === kind && call.target === target))
        throw new JobConflictError("此来源今天已经请求过，明天继续");
      const refreshed = prior
        .filter((call) => call.kind === "refresh")
        .flatMap((call) => call.tweetIds);
      if (
        kind === "refresh" &&
        (!tweetIds.length ||
          tweetIds.length > 20 ||
          new Set(tweetIds).size !== tweetIds.length ||
          refreshed.length + tweetIds.length > 100 ||
          tweetIds.some((id) => refreshed.includes(id)))
      )
        throw new JobConflictError("指标刷新超出每日上限或重复请求");
      this.db
        .prepare("INSERT INTO social_provider_calls VALUES (?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          brandId,
          day.dayKey,
          kind,
          target,
          JSON.stringify(tweetIds),
          this.now(),
        );
    });
  }

  reserveSocialSelectionCall(options: {
    brandId: string;
    task: "selection" | "selection_review";
    candidateIds: string[];
  }) {
    return this.transaction(() => {
      if (this.socialQuotas(options.brandId).selection.used >= 40)
        throw new JobConflictError("今日筛选与归组已达 40 次，明天继续");
      return this.recordSelectionModelCall(options);
    });
  }

  recordSocialObservation(candidateId: string, snapshot: XPostSnapshot) {
    const candidate = this.getCandidate(candidateId);
    if (
      !candidate ||
      candidate.urlKey !==
        sourceMaterialKey({
          url: `https://x.com/i/status/${snapshot.tweetId}`,
        }) ||
      candidate.origin !== "twitterapi-user"
    )
      throw new TypeError(
        "Provider observation must match an existing provider candidate",
      );
    this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO social_observations VALUES (?,?,?,?)")
        .run(
          candidateId,
          candidate.brandId,
          snapshot.observedAt,
          JSON.stringify(snapshot),
        );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO social_candidates(candidate_id) VALUES (?)",
        )
        .run(candidateId);
    });
  }

  socialHistory(brandId: string): SocialMetricSnapshot[] {
    return this.db
      .prepare(
        "SELECT candidate_id,snapshot_json FROM social_observations WHERE brand_id=? AND observed_at>=? ORDER BY observed_at,candidate_id",
      )
      .all(brandId, this.now() - 30 * DAY)
      .map((row) => ({
        ...JSON.parse(String(row.snapshot_json)),
        candidateId: String(row.candidate_id),
      }));
  }

  latestSocialSnapshot(candidateId: string): XPostSnapshot | null {
    const row = this.db
      .prepare(
        "SELECT snapshot_json FROM social_observations WHERE candidate_id=? ORDER BY observed_at DESC LIMIT 1",
      )
      .get(candidateId);
    return row ? JSON.parse(String(row.snapshot_json)) : null;
  }

  completeSocialSourceCheck(
    claim: Parameters<ContentOperationsStore["completeSourceCheck"]>[0],
    input: Parameters<ContentOperationsStore["completeSourceCheck"]>[1],
    snapshots: Map<string, XPostSnapshot>,
  ) {
    return this.transaction(() => {
      const result = this.completeSourceCheck(claim, input);
      const candidates = new Map(
        this.listCandidates({ brandId: claim.brandId, limit: 10000 }).map(
          (candidate) => [candidate.urlKey, candidate],
        ),
      );
      for (const source of input.inputs) {
        const key = sourceMaterialKey(source);
        const snapshot = snapshots.get(key);
        const candidate = candidates.get(key);
        if (snapshot && candidate?.origin === "twitterapi-user")
          this.recordSocialObservation(candidate.id, snapshot);
      }
      return result;
    });
  }

  prepareSocialSourceDay(brandId: string, sourceIds: string[]) {
    const { day } = this.socialQuotas(brandId);
    const requested = new Set(
      this.providerRequests(brandId)
        .filter((call) => call.kind === "timeline")
        .map((call) => call.target),
    );
    for (const sourceId of sourceIds.filter((id) => !requested.has(id)))
      this.db
        .prepare(
          "UPDATE source_checkpoints SET next_check_at=? WHERE brand_id=? AND source_id=? AND lease_token IS NULL",
        )
        .run(day.startsAt + 9 * 3_600_000, brandId, sourceId);
  }

  isSocialProtected(candidate: ContentCandidate): boolean {
    if (candidate.legacyJobIds.length || candidate.legacyConflict) return true;
    const topic = candidate.topicId ? this.getTopic(candidate.topicId) : null;
    return Boolean(
      topic &&
      (topic.hasContent ||
        ["ready", "rejected", "existing"].includes(topic.status)),
    );
  }

  private isSocialEvaluationProtected(candidate: ContentCandidate): boolean {
    // A linked proposal must not be evaluated twice, even while it remains
    // visible for human approval in the current selection view.
    return (
      this.isSocialProtected(candidate) ||
      Boolean(candidate.topicId) ||
      ["selected", "rejected"].includes(candidate.status)
    );
  }

  listSocialStates(
    brandId: string,
    activeSourceIds?: string[],
  ): SocialCandidateState[] {
    const history = this.socialHistory(brandId);
    const states = this.listCandidates({ brandId, limit: 10000 })
      .filter((candidate) => candidate.origin === "twitterapi-user")
      .map((candidate) => {
        const row = this.db
          .prepare("SELECT * FROM social_candidates WHERE candidate_id=?")
          .get(candidate.id);
        const social = this.latestSocialSnapshot(candidate.id);
        const assessment = row?.assessment_json
          ? JSON.parse(String(row.assessment_json))
          : null;
        const performance = social
          ? calculateSocialPerformance(
              {
                id: candidate.id,
                ...(candidate.document ?? candidate.input),
                text: candidate.document?.text ?? candidate.input.text ?? "",
                primary: candidate.primary,
                firstSeenAt: candidate.createdAt,
                social,
              },
              history,
              this.now(),
            )
          : null;
        const score = assessment
          ? Math.round(
              performance?.score === null || !performance
                ? (assessment.relevance * 35 + assessment.reusability * 25) / 60
                : performance.score * 0.4 +
                    assessment.relevance * 0.35 +
                    assessment.reusability * 0.25,
            )
          : null;
        const held = Boolean(row?.held);
        let tier: SocialCandidateState["tier"] = "pending";
        const recent =
          social?.publishedAt &&
          Date.parse(social.publishedAt) >= this.now() - 7 * DAY;
        if (
          this.isSocialProtected(candidate) ||
          (activeSourceIds &&
            !activeSourceIds.includes(candidate.sourceId ?? "")) ||
          (social && !recent)
        )
          tier = "history";
        else if (held) tier = "watch";
        else if (row?.error_code) tier = "error";
        else if (assessment) {
          if (
            assessment.excludedReason ||
            assessment.relevance < 60 ||
            assessment.reusability < 50
          )
            tier = "not_recommended";
          else if (
            held ||
            !performance?.sufficient ||
            score === null ||
            score < 65
          )
            tier = "watch";
          else tier = "recommended";
        } else if (candidate.lastError) tier = "error";
        return {
          candidateId: candidate.id,
          social,
          assessment,
          performance,
          score,
          tier,
          attempts: Number(row?.attempts ?? 0),
          errorCode: row?.error_code
            ? (String(row.error_code) as SocialCandidateState["errorCode"])
            : null,
          errorMessage: row?.error_message
            ? String(row.error_message)
            : candidate.lastError,
          evaluatedAt: row?.evaluated_at ? Number(row.evaluated_at) : null,
          held,
        };
      });
    states.sort(
      (a, b) =>
        (b.score ?? -1) - (a.score ?? -1) ||
        a.candidateId.localeCompare(b.candidateId),
    );
    let recommended = 0;
    const accounts = new Map<string, number>();
    for (const state of states.filter((item) => item.tier === "recommended")) {
      const account = state.social!.authorHandle.toLowerCase();
      if (recommended >= 10 || (accounts.get(account) ?? 0) >= 3)
        state.tier = "watch";
      else {
        recommended++;
        accounts.set(account, (accounts.get(account) ?? 0) + 1);
      }
    }
    return states;
  }

  socialEvaluationCandidates(
    brandId: string,
    activeSourceIds: string[],
  ): ContentCandidate[] {
    const { day } = this.socialQuotas(brandId);
    return this.listCandidates({ brandId, limit: 10000 })
      .filter((candidate) => {
        if (
          !activeSourceIds.includes(candidate.sourceId ?? "") ||
          this.isSocialEvaluationProtected(candidate)
        )
          return false;
        const social = this.latestSocialSnapshot(candidate.id);
        if (
          !social?.publishedAt ||
          Date.parse(social.publishedAt) < this.now() - 7 * DAY ||
          social.observedAt < day.startsAt
        )
          return false;
        const row = this.db
          .prepare("SELECT * FROM social_candidates WHERE candidate_id=?")
          .get(candidate.id);
        return (
          !row?.held &&
          !row?.assessment_json &&
          Number(row?.attempts ?? 0) < 2 &&
          Number(row?.next_attempt_at ?? 0) <= this.now()
        );
      })
      .slice(0, 5);
  }

  beginSocialEvaluation(candidateIds: string[]) {
    this.transaction(() => {
      for (const id of candidateIds) {
        const candidate = this.getCandidate(id);
        if (
          !candidate ||
          candidate.origin !== "twitterapi-user" ||
          this.isSocialEvaluationProtected(candidate) ||
          !["new", "failed", "needs_review"].includes(candidate.status)
        )
          throw new JobConflictError("该素材已被人工处理");
        const result = this.db
          .prepare(
            "UPDATE social_candidates SET attempts=attempts+1, next_attempt_at=?,error_code='provider',error_message='上次评估未完成，等待有界重试' WHERE candidate_id=? AND held=0 AND attempts<2 AND assessment_json IS NULL AND next_attempt_at<=?",
          )
          .run(this.now() + 60_000, id, this.now());
        if (!result.changes)
          throw new JobConflictError("此素材已评估或达到重试上限");
      }
    });
  }

  saveSocialSelection(brandId: string, result: SocialSelectionResult) {
    this.transaction(() => {
      const affected = new Set([
        ...result.assessments.map((item) => item.candidateId),
        ...result.failures.map((item) => item.candidateId),
        ...result.selection.candidateDecisions.map((item) => item.candidateId),
      ]);
      for (const id of affected) {
        const candidate = this.getCandidate(id);
        if (
          !candidate ||
          candidate.brandId !== brandId ||
          candidate.origin !== "twitterapi-user" ||
          this.isSocialEvaluationProtected(candidate) ||
          Boolean(
            this.db
              .prepare(
                "SELECT 1 FROM social_candidates WHERE candidate_id=? AND held=1",
              )
              .get(id),
          ) ||
          !["new", "failed", "needs_review"].includes(candidate.status)
        )
          throw new JobConflictError("人工决定已保存，不能被自动评估覆盖");
      }
      // The original generic selector only accepts status=new. Historical
      // unlinked model failures are safe to retry, and this reset rolls back
      // with the whole selection if any later validation fails.
      for (const decision of result.selection.candidateDecisions) {
        this.db
          .prepare(
            "UPDATE content_candidates SET status='new',updated_at=? WHERE id=? AND status IN ('failed','needs_review') AND topic_id IS NULL AND legacy_conflict=0",
          )
          .run(this.now(), decision.candidateId);
      }
      this.saveSelection({ brandId, result: result.selection });
      // A grouping failure does not invalidate the independent source assessment.
      for (const assessment of result.assessments)
        this.db
          .prepare(
            "UPDATE social_candidates SET assessment_json=?,error_code=NULL,error_message=NULL,evaluated_at=? WHERE candidate_id=?",
          )
          .run(JSON.stringify(assessment), this.now(), assessment.candidateId);
      for (const failure of result.failures)
        this.db
          .prepare(
            "UPDATE social_candidates SET error_code=?,error_message=?,evaluated_at=? WHERE candidate_id=?",
          )
          .run(failure.code, failure.message, this.now(), failure.candidateId);
      this.recordAudit({
        brandId,
        eventType: "social.selection",
        actor: "selector",
        reason: "保存社媒评估和独立异常",
        after: result,
      });
    });
  }

  holdSocialCandidate(
    brandId: string,
    id: string,
    held: boolean,
    reason: string,
  ) {
    const candidate = this.getCandidate(id);
    if (
      !candidate ||
      candidate.brandId !== brandId ||
      this.isSocialProtected(candidate)
    )
      throw new JobConflictError("已处理素材不能改为观察");
    this.transaction(() => {
      const previousHeld = Boolean(
        this.db
          .prepare("SELECT held FROM social_candidates WHERE candidate_id=?")
          .get(id)?.held,
      );
      this.db
        .prepare(
          "INSERT INTO social_candidates(candidate_id,held) VALUES (?,?) ON CONFLICT(candidate_id) DO UPDATE SET held=excluded.held",
        )
        .run(id, held ? 1 : 0);
      this.recordAudit({
        brandId,
        eventType: "social.held",
        reason,
        before: { held: previousHeld },
        after: { candidateId: id, held },
      });
    });
  }

  retrySocialCandidate(brandId: string, id: string, reason: string) {
    const candidate = this.getCandidate(id);
    const row = this.db
      .prepare("SELECT * FROM social_candidates WHERE candidate_id=?")
      .get(id);
    if (
      !candidate ||
      candidate.brandId !== brandId ||
      this.isSocialEvaluationProtected(candidate) ||
      row?.held ||
      row?.assessment_json ||
      !row?.error_code ||
      Number(row.attempts) >= 2
    )
      throw new JobConflictError("该素材不能重试，或已达到两次评估上限");
    this.db
      .prepare(
        "UPDATE social_candidates SET next_attempt_at=0 WHERE candidate_id=?",
      )
      .run(id);
    this.recordAudit({
      brandId,
      eventType: "social.retry_requested",
      reason,
      after: { candidateId: id },
    });
  }

  private recoveryHistory(
    brandId: string,
    candidateId: string,
  ): RecoveryClaim[] {
    return this.db
      .prepare(
        "SELECT after_json FROM audit_events WHERE brand_id=? AND event_type='social.recovery_started' AND EXISTS (SELECT 1 FROM json_each(after_json,'$.candidateIds') WHERE value=?) ORDER BY rowid",
      )
      .all(brandId, candidateId)
      .map((row) => JSON.parse(String(row.after_json)) as RecoveryClaim);
  }

  private recoveryHumanChanged(
    brandId: string,
    candidateId: string,
    token: string,
  ) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM audit_events WHERE brand_id=? AND rowid>(SELECT rowid FROM audit_events WHERE event_type='social.recovery_started' AND json_extract(after_json,'$.token')=?) AND ((event_type='social.held' AND json_extract(after_json,'$.candidateId')=?) OR (event_type IN ('candidate.retried','candidate.legacy_resolved') AND json_extract(after_json,'$.id')=?))",
        )
        .get(brandId, token, candidateId, candidateId),
    );
  }

  private recoveryCandidateVersion(candidate: ContentCandidate) {
    return stableHash({
      status: candidate.status,
      topicId: candidate.topicId,
      contentHash: candidate.contentHash,
      document: candidate.document,
      primary: candidate.primary,
      fetchState: candidate.fetchState,
      legacyConflict: candidate.legacyConflict,
      legacyJobIds: candidate.legacyJobIds,
    });
  }

  socialRecoveryStatus(brandId: string, candidateId: string) {
    const candidate = this.getCandidate(candidateId);
    if (!candidate || candidate.brandId !== brandId)
      throw new JobConflictError("素材不存在");
    const history = this.recoveryHistory(brandId, candidateId);
    const last = history[history.length - 1];
    const completed =
      last &&
      this.db
        .prepare(
          "SELECT 1 FROM audit_events WHERE brand_id=? AND event_type='social.recovery_completed' AND json_extract(after_json,'$.token')=?",
        )
        .get(brandId, last.token);
    return {
      manualAttempts: history.filter((entry) => entry.kind === "retry").length,
      limit: 2,
      inFlight: Boolean(
        last &&
        !completed &&
        last.leaseUntil > this.now() &&
        !this.recoveryHumanChanged(brandId, candidateId, last.token),
      ),
      leaseUntil: last && !completed ? last.leaseUntil : null,
    };
  }

  private recoverableBatch(options: SocialRecoveryOptions) {
    const candidate = this.getCandidate(options.candidateId);
    const topic = candidate?.topicId ? this.getTopic(candidate.topicId) : null;
    const candidateIds = topic
      ? this.db
          .prepare(
            "SELECT id FROM content_candidates WHERE topic_id=? ORDER BY id",
          )
          .all(topic.id)
          .map((row) => String(row.id))
      : [options.candidateId];
    if (!candidateIds.length || candidateIds.length > 5)
      throw new JobConflictError("人工恢复每批最多五个素材");
    if (
      topic &&
      (topic.status !== "needs_review" ||
        topic.hasContent ||
        this.getTopicIntent(topic.id))
    )
      throw new JobConflictError("已处理或待批准选题不能重新归组");
    if (
      topic &&
      this.db
        .prepare(
          "SELECT 1 FROM content_topics WHERE id<>? AND EXISTS (SELECT 1 FROM json_each(conflicting_topic_ids_json) WHERE value=?)",
        )
        .get(topic.id, topic.id)
    )
      throw new JobConflictError("其他选题仍引用此提案，请先核对它们的归属");
    const candidates = candidateIds.map((id) => {
      const item = this.getCandidate(id);
      const row = this.db
        .prepare("SELECT * FROM social_candidates WHERE candidate_id=?")
        .get(id);
      const state = this.socialRecoveryStatus(options.brand.id, id);
      const history = this.recoveryHistory(options.brand.id, id);
      const last = history[history.length - 1];
      const expiredLock =
        row?.held &&
        last &&
        state.leaseUntil !== null &&
        !state.inFlight &&
        state.leaseUntil <= this.now() &&
        !this.recoveryHumanChanged(options.brand.id, id, last.token);
      if (
        !item ||
        item.brandId !== options.brand.id ||
        item.origin !== "twitterapi-user" ||
        this.isSocialProtected(item) ||
        item.status === "rejected" ||
        state.inFlight ||
        (row?.held && !expiredLock) ||
        (!topic &&
          !row?.error_code &&
          !(row?.assessment_json && item.status === "needs_review"))
      )
        throw new JobConflictError(
          "该素材已被人工处理、正在恢复或没有可恢复的异常",
        );
      const document =
        item.document ??
        (item.input.text ? { ...item.input, text: item.input.text } : null);
      const social = this.latestSocialSnapshot(id);
      if (!document?.text.trim() || !social)
        throw new JobConflictError("人工恢复需要已保存的正文和可信社媒快照");
      return { candidate: item, row, document, social, state };
    });
    return { candidates, topic };
  }

  private startSocialRecovery(
    options: SocialRecoveryOptions,
    kind: RecoveryClaim["kind"],
  ) {
    if (
      typeof options.reason !== "string" ||
      !options.reason.trim() ||
      options.reason.length > 2000
    )
      throw new TypeError("人工恢复理由须为 1–2000 字符");
    return this.transaction(() => {
      const batch = this.recoverableBatch(options);
      if (
        kind === "retry" &&
        (this.socialQuotas(options.brand.id).selection.used >= 40 ||
          batch.candidates.some((item) => item.state.manualAttempts >= 2))
      )
        throw new JobConflictError("今日筛选预算或额外两次人工重试已耗尽");
      if (
        kind === "repair" &&
        batch.candidates.some(
          (item) =>
            !item.row?.assessment_json ||
            JSON.parse(String(item.row.assessment_json)).excludedReason,
        )
      )
        throw new JobConflictError(
          "人工修正需要合法且未排除的评估，请先显式重试评估",
        );
      const claim: RecoveryClaim = {
        token: randomUUID(),
        kind,
        candidateIds: batch.candidates.map((item) => item.candidate.id),
        attempts: Object.fromEntries(
          batch.candidates.map((item) => [
            item.candidate.id,
            Number(item.row?.attempts ?? 0) + (kind === "retry" ? 1 : 0),
          ]),
        ),
        leaseUntil: this.now() + 5 * 60_000,
        candidateVersions: {},
        ...(batch.topic ? { topicVersion: stableHash(batch.topic) } : {}),
      };
      for (const item of batch.candidates) {
        this.db
          .prepare(
            "UPDATE social_candidates SET held=1,attempts=? WHERE candidate_id=?",
          )
          .run(claim.attempts[item.candidate.id], item.candidate.id);
        if (!item.candidate.document)
          this.recordCandidateDocument(item.candidate.id, item.document);
        claim.candidateVersions[item.candidate.id] =
          this.recoveryCandidateVersion(this.getCandidate(item.candidate.id)!);
      }
      this.recordAudit({
        brandId: options.brand.id,
        eventType: "social.recovery_started",
        reason: options.reason,
        before: {
          topic: batch.topic,
          candidates: batch.candidates.map(({ candidate, row }) => ({
            candidate,
            social: row,
          })),
        },
        after: claim,
      });
      return { ...batch, claim };
    });
  }

  private assertSocialRecovery(
    options: SocialRecoveryOptions,
    claim: RecoveryClaim,
  ) {
    for (const id of claim.candidateIds) {
      const candidate = this.getCandidate(id);
      const row = this.db
        .prepare("SELECT * FROM social_candidates WHERE candidate_id=?")
        .get(id);
      const history = this.recoveryHistory(options.brand.id, id);
      const last = history[history.length - 1];
      const humanChanged = this.recoveryHumanChanged(
        options.brand.id,
        id,
        claim.token,
      );
      if (
        !candidate ||
        this.isSocialProtected(candidate) ||
        candidate.status === "rejected" ||
        !row?.held ||
        Number(row.attempts) !== claim.attempts[id] ||
        last?.token !== claim.token ||
        humanChanged ||
        this.now() >= claim.leaseUntil ||
        this.recoveryCandidateVersion(candidate) !==
          claim.candidateVersions[id] ||
        (claim.topicVersion &&
          (!candidate.topicId ||
            stableHash(this.getTopic(candidate.topicId)) !==
              claim.topicVersion))
      )
        throw new JobConflictError(
          "人工决定、暂停或恢复租约已变化，晚到结果不能覆盖",
        );
    }
  }

  private finishSocialRecovery(
    options: SocialRecoveryOptions,
    claim: RecoveryClaim,
    result: SocialSelectionResult,
  ) {
    return this.transaction(() => {
      this.assertSocialRecovery(options, claim);
      const before = claim.candidateIds.map((id) => this.getCandidate(id)!);
      const topic = before[0].topicId ? this.getTopic(before[0].topicId) : null;
      if (result.failures.length) {
        // Keep the old proposal and independent assessments until the entire batch succeeds.
        for (const id of claim.candidateIds) {
          const assessment = result.assessments.find(
            (item) => item.candidateId === id,
          );
          const failure = result.failures.find(
            (item) => item.candidateId === id,
          );
          this.db
            .prepare(
              "UPDATE social_candidates SET held=0,assessment_json=COALESCE(?,assessment_json),error_code=?,error_message=?,evaluated_at=? WHERE candidate_id=?",
            )
            .run(
              assessment ? JSON.stringify(assessment) : null,
              failure?.code ?? "coverage",
              failure?.message ?? "同组素材恢复未完成，请人工核对",
              this.now(),
              id,
            );
        }
        result = {
          ...result,
          selection: {
            ...result.selection,
            candidateDecisions: [],
            topics: [],
          },
        };
      } else {
        if (topic) {
          if (
            topic.status !== "needs_review" ||
            topic.hasContent ||
            this.db
              .prepare(
                "SELECT 1 FROM content_topics WHERE id<>? AND EXISTS (SELECT 1 FROM json_each(conflicting_topic_ids_json) WHERE value=?)",
              )
              .get(topic.id, topic.id)
          )
            throw new JobConflictError("原提案已变化，不能替换");
          this.db
            .prepare("DELETE FROM topic_candidate_links WHERE topic_id=?")
            .run(topic.id);
          this.db
            .prepare(
              "UPDATE content_candidates SET topic_id=NULL WHERE topic_id=?",
            )
            .run(topic.id);
          this.db
            .prepare("DELETE FROM content_topics WHERE id=?")
            .run(topic.id);
        }
        // A repaired source may match approved history. Preserve that record in full;
        // only an explicit existing merge action may attach its new evidence.
        for (const selected of result.selection.topics) {
          const existing = this.getTopic(
            selected.existingTopicId ?? selected.id,
          );
          if (
            !existing ||
            !(
              existing.hasContent ||
              ["ready", "rejected", "existing"].includes(existing.status)
            )
          )
            continue;
          const oldId = selected.id;
          selected.id = `recovery-${randomUUID()}`;
          selected.identityKey = selected.id;
          selected.status = "needs_review";
          selected.conflictingTopicIds = [
            ...new Set([existing.id, ...existing.conflictingTopicIds]),
          ];
          delete selected.existingTopicId;
          // The historical eight-source cap may have excluded every new source.
          // A conflict proposal owns only its current, explicitly recovered members.
          selected.sourceMetadata = selected.candidateIds.map((id) => {
            const candidate = this.getCandidate(id)!;
            return {
              candidateId: id,
              url: candidate.document?.url ?? candidate.input.url,
              primary: candidate.primary,
              ...(candidate.input.publishedAt
                ? { publishedAt: candidate.input.publishedAt }
                : {}),
              totalScore: result.selection.candidateDecisions.find(
                (item) => item.candidateId === id,
              )!.totalScore,
            };
          });
          selected.sourceCandidateIds = selected.sourceMetadata.map(
            (item) => item.candidateId,
          );
          for (const decision of result.selection.candidateDecisions.filter(
            (item) => item.topicId === oldId,
          )) {
            decision.topicId = selected.id;
            decision.status = "needs_review";
          }
        }
        for (const id of claim.candidateIds) {
          this.db
            .prepare(
              "UPDATE social_candidates SET held=0,assessment_json=NULL,error_code=NULL,error_message=NULL WHERE candidate_id=?",
            )
            .run(id);
          this.db
            .prepare("UPDATE content_candidates SET status='new' WHERE id=?")
            .run(id);
        }
        this.saveSocialSelection(options.brand.id, result);
      }
      this.recordAudit({
        brandId: options.brand.id,
        eventType: "social.recovery_completed",
        reason: options.reason,
        before: { candidates: before, topic },
        after: { token: claim.token, result },
      });
      return result;
    });
  }

  async retrySocialEvaluation(
    options: SocialRecoveryOptions,
    deps: { model: ContentModel },
  ) {
    const batch = this.startSocialRecovery(options, "retry");
    const result = await selectSocialCandidates(
      {
        brand: options.brand,
        now: this.now(),
        history: this.socialHistory(options.brand.id),
        existingTopics: this.listTopics({ brandId: options.brand.id }).filter(
          (topic) => topic.id !== batch.topic?.id,
        ),
        candidates: batch.candidates.map((item) => ({
          id: item.candidate.id,
          ...item.document,
          primary: item.candidate.primary,
          firstSeenAt: item.candidate.createdAt,
          social: item.social,
        })),
      },
      {
        model: {
          invoke: (request) => {
            this.assertSocialRecovery(options, batch.claim);
            this.reserveSocialSelectionCall({
              brandId: options.brand.id,
              task: request.task as "selection" | "selection_review",
              candidateIds: batch.claim.candidateIds,
            });
            return deps.model.invoke(request);
          },
        },
      },
    );
    return this.finishSocialRecovery(options, batch.claim, result);
  }

  async repairSocialCandidate(
    options: SocialRecoveryOptions & {
      kind: "creative" | "announcement";
      identity?: TopicIdentity;
      identityEvidence?: string;
    },
  ) {
    if (
      !["creative", "announcement"].includes(options.kind) ||
      (options.kind === "announcement" &&
        (!options.identity || !options.identityEvidence?.trim())) ||
      (options.kind === "creative" &&
        (options.identity !== undefined ||
          options.identityEvidence !== undefined))
    )
      throw new TypeError(
        "事件修正必须提供身份和来源原文；创意修正不接受事件身份",
      );
    const batch = this.startSocialRecovery(options, "repair");
    const result = await selectSocialCandidates(
      {
        brand: options.brand,
        now: this.now(),
        history: this.socialHistory(options.brand.id),
        existingTopics: this.listTopics({ brandId: options.brand.id }).filter(
          (topic) => topic.id !== batch.topic?.id,
        ),
        candidates: batch.candidates.map((item) => ({
          id: item.candidate.id,
          ...item.document,
          primary: item.candidate.primary,
          firstSeenAt: item.candidate.createdAt,
          social: item.social,
        })),
      },
      {
        model: {
          async invoke(request) {
            if (request.task === "selection_review")
              return JSON.stringify({
                groups: JSON.parse(request.user).groups.map(
                  (group: { topicId: string }) => ({
                    topicId: group.topicId,
                    confirmed: true,
                    reason: options.reason,
                  }),
                ),
              });
            return JSON.stringify({
              decisions: batch.candidates.map((item) => ({
                ...(JSON.parse(
                  String(item.row!.assessment_json),
                ) as SocialAssessment),
                kind: options.kind,
                identity: options.identity ?? null,
                identityEvidence: options.identityEvidence ?? null,
                certainty: "confirmed",
              })),
            });
          },
        },
      },
    );
    result.selection.modelCalls = 0;
    return this.finishSocialRecovery(options, batch.claim, result);
  }

  getTopicIntent(topicId: string): WritingIntent | null {
    const row = this.db
      .prepare("SELECT intent_json FROM social_topic_intents WHERE topic_id=?")
      .get(topicId);
    return row ? JSON.parse(String(row.intent_json)) : null;
  }

  protected saveTopicIntent(
    topicId: string,
    intent: WritingIntent,
    snapshot: unknown,
  ) {
    this.db
      .prepare("INSERT INTO social_topic_intents VALUES (?,?,?)")
      .run(topicId, JSON.stringify(intent), JSON.stringify(snapshot));
  }
}
