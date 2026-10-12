export class LeaseLostError extends Error {
  constructor(id: string) {
    super(`Content job ${id} is no longer owned by this lease`);
    this.name = "LeaseLostError";
  }
}

export class JobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobConflictError";
  }
}

// Only readiness findings are safe to present to an authenticated operator;
// other state conflicts may contain internal identifiers or diagnostics.
export class WritingReadinessError extends JobConflictError {
  constructor(readonly missing: readonly string[]) {
    super(`待补充品牌资料：${missing.join("；")}`);
    this.name = "WritingReadinessError";
  }
}
