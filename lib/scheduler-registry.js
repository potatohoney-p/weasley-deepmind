/**
 * 스케줄러 작업 레지스트리 — 각 백그라운드 작업의 실행 이력을 추적한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-31
 */

export class SchedulerRegistry {
  #jobs = new Map();

  /**
   * 작업 성공을 기록한다.
   * @param {string}      name    - 작업 식별자
   * @param {object|null} summary - 성공 요약 (선택)
   */
  recordSuccess(name, summary = null) {
    const job      = this.#getOrCreate(name);
    job.lastSuccess = new Date().toISOString();
    job.lastSummary = summary;
    job.runCount++;
  }

  /**
   * 작업 실패를 기록한다.
   * @param {string} name  - 작업 식별자
   * @param {Error}  error - 발생한 에러
   */
  recordFailure(name, error) {
    const job       = this.#getOrCreate(name);
    job.lastFailure  = new Date().toISOString();
    job.lastError    = error?.message || String(error);
    job.failureCount++;
    job.runCount++;
  }

  /**
   * 등록된 모든 작업의 상태를 반환한다.
   * @returns {Record<string, object>}
   */
  getAll() {
    const result = {};
    for (const [name, job] of this.#jobs) {
      result[name] = { ...job };
    }
    return result;
  }

  /** @param {string} name */
  #getOrCreate(name) {
    if (!this.#jobs.has(name)) {
      this.#jobs.set(name, {
        lastSuccess:  null,
        lastFailure:  null,
        lastError:    null,
        lastSummary:  null,
        runCount:     0,
        failureCount: 0,
      });
    }
    return this.#jobs.get(name);
  }
}

/** 프로세스 전역 싱글턴 */
let _registry = null;

/** @returns {SchedulerRegistry} */
export function getSchedulerRegistry() {
  if (!_registry) _registry = new SchedulerRegistry();
  return _registry;
}
