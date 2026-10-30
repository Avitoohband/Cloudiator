/**
 * Stable, secret-free failure codes. Raw exception text is never stored, logged or returned. `runWorker` records a thrown
 * `WorkerFailure`'s code and anything else as `execution-failed`; a version this worker cannot run is `unsupported-rules`,
 * which the runbook and the release health check look for (it needs a deploy, not a retry). Its own module, so the worker's
 * database adapter (database.ts) throws it without importing the executors. No parameter property: Node scripts load
 * database.ts with type stripping only (tests/scripts/bench-seed.test.ts), which refuses one.
 */
export type FailureCode = 'unsupported-rules' | 'unsupported-executor' | 'invalid-input' | 'invalid-build' | 'invalid-result' | 'execution-failed';
export class WorkerFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(code); this.code = code; this.name = 'WorkerFailure'; }
}
