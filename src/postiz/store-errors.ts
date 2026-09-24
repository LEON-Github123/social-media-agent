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
