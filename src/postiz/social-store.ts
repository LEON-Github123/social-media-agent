import { randomUUID } from "node:crypto";
import { ContentOperationsStore } from "./operations-store.js";
import { JobConflictError } from "./store-errors.js";
import { calculateSocialPerformance } from "./social-selector.js";
import { sourceMaterialKey } from "./identity.js";
import type { ContentCandidate } from "./operations-store.js";
import type {
  SocialCandidateState,
  SocialMetricSnapshot,
  SocialSelectionResult,
  XPostSnapshot,
} from "./social-types.js";

const DAY = 86_400_000;
export interface WritingIntent {
  purpose: "brand_original";
  writingAngle?: string;
  inspirationRequiresFacts: boolean;
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
          this.isSocialProtected(candidate)
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
        if (!candidate || this.isSocialProtected(candidate))
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
          this.isSocialProtected(candidate)
        )
          throw new JobConflictError("人工决定已保存，不能被自动评估覆盖");
      }
      this.saveSelection({ brandId, result: result.selection });
      for (const assessment of result.assessments.filter(
        (item) =>
          !result.failures.some(
            (failure) => failure.candidateId === item.candidateId,
          ),
      ))
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
      this.isSocialProtected(candidate) ||
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
