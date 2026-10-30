# Features Ledger

weasley-deepmind의 주요 모듈을 한 페이지로 정리한 ledger. 새 모듈 추가·deprecation 시 본 표에 행을 추가하거나 갱신한다. 운영 디버깅에서 "이 ENV는 어디에 쓰이지? 이 메트릭은 어느 모듈 거지?" 질문에 한 곳에서 답을 찾을 수 있도록 한다.

본 문서는 권위 출처가 아니라 운영 ledger다. 코드 본문과 어긋날 경우 코드를 신뢰하고 본 표를 갱신한다.

## 모듈 ledger

|모듈|입력|출력|주된 실패 모드|관련 ENV|관련 메트릭|관련 migration|
|-|-|-|-|-|-|-|
|`ContextBuilder` (`lib/memory/read/ContextBuilder.js`)|context params, core/working/anchor candidates|deduplicated flat or structured injection; shared ranked selection and cl100k_base content-token totals|mandatory anchors may exceed the requested budget; JSON/section labels and auxiliary learning metadata are outside the content budget|`WEASLEY_DEEPMIND_CONTEXT_ANCHOR_LIMIT`|—|—|
|Offline recall evaluation (`scripts/evaluate-recall.js`)|Synthetic revision corpus, current/legacy-cache variant|Deterministic paired JSON report, exit 0/1/2|Invalid/missing cases, stale content, budget/accounting mismatch, full-budget miss; Node 24 required|Isolated synthetic child environment|Recall/precision with denominators, stale returns, cache differences|None|
|`MemoryRememberer.forget` → `FragmentWriter.deleteByTopic`|topic, agentId, owner key, force/dryRun|deleted/protected 또는 비변경 preview counts|트랜잭션 실패 시 링크·파편 롤백. 캐시 제거는 커밋 후 best-effort|`REDIS_ENABLED`|—|기존 fragment_versions CASCADE, 새 migration 없음|
|`MemoryRememberer` (`lib/memory/processors/MemoryRememberer.js`)|remember params (content/type/topic/keywords/importance 등)|`{id, keywords, ttl_tier, scope, conflicts, validation_warnings?}`|quota 초과(`fragment_limit_exceeded`), hard gate `SymbolicPolicyViolationError`, idempotency 충돌|`WEASLEY_DEEPMIND_REMEMBER_ATOMIC`, `WEASLEY_DEEPMIND_POLICY_RULES`|`weasley_deepmind_policy_warning_total`, `weasley_deepmind_policy_gate_block_total`|migration-031 (per-key content_hash), migration-034 (idempotency tenant/master unique)|
|`BatchRememberProcessor`|fragment 배열 + keyId (async=true 시 Redis 큐 적재 후 즉시 반환)|`{insertedIds, skipped, conflicts}` 또는 `{async:true, accepted, rejected, jobId}`|quota Phase B 초과 시 ROLLBACK, 256KB/500행 chunk 한도; async=true 시 Redis 미연결이면 동기 경로 폴백|`BATCH_DATABASE_URL`|`mcp_batch_pool_active_connections`, `mcp_batch_pool_idle_connections`, `mcp_batch_pool_waiting_count`|migration-035 (morpheme_indexed)|
|`FragmentSearch` (`lib/memory/read/FragmentSearch.js`)|`recall` params (text/keywords/topic/type/timeRange/contextText); text-only는 최대 5개 용어로 durable keyword 검색, 임베딩 선택적|`{fragments[], searchPath, _meta:{searchEventId,hints,suggestion}}`; semantic/reranker 점수 없으면 keyword coverage 우선|empty results (저장 keyword 불일치 포함), similarity 임계 미달, NLI 실패 (soft fallback); [text 검색 범위](operations/text-keyword-recall.md)|`ENABLE_SPREADING_ACTIVATION`, `WEASLEY_DEEPMIND_SYMBOLIC_EXPLAIN`|`weasley_deepmind_recall_*`, `weasley_deepmind_search_event_total`|migration-027 (reconsolidation/episode/spreading)|
|`FragmentWriter` (`lib/memory/write/FragmentWriter.js`)|fragment 객체|insert/update id|RLS 거부, content_hash 충돌, `validation_warnings` 누적 후 INSERT|`WEASLEY_DEEPMIND_SCHEMA`|`weasley_deepmind_fragment_writes_total`|core schema|
|`MemoryConsolidator` (`lib/memory/consolidate/MemoryConsolidator.js`)|cycle trigger|stage 결과 22항목 + per-stage timing|stage별 query error는 stage 결과에 잡힘, 다음 stage 진행|`WEASLEY_DEEPMIND_CONSOLIDATE_*`, `WEASLEY_DEEPMIND_CONSOLIDATE_TIMEOUT_MS`|`weasley_deepmind_consolidation_stage_ms`|해당 없음 (로직 전용)|
|`ReconsolidationEngine` (`lib/memory/link/ReconsolidationEngine.js`)|tool_feedback 누적|link weight 갱신|fragment_links 부재, search_event_id 무효|`WEASLEY_DEEPMIND_RECONSOLIDATION_ENABLED`|`weasley_deepmind_link_weight_*`|migration-027|
|`SpreadingActivation` (`lib/memory/signals/SpreadingActivation.js`)|contextText + 시드 파편|ema_activation boost|graph 부재 시 noop|`ENABLE_SPREADING_ACTIVATION`|`weasley_deepmind_spreading_activation_total`|migration-027|
|`CaseRewardBackprop` (`lib/memory/signals/CaseRewardBackprop.js`)|case_event outcome|case_events DAG 보상|case_id 없는 fragment는 skip|`WEASLEY_DEEPMIND_CASE_BACKPROP_ENABLED`|`weasley_deepmind_case_reward_total`|migration-027|
|`EmbeddingWorker` (`lib/memory/embedding/EmbeddingWorker.js`)|orphan fragment 배치|embedding INSERT, morpheme INSERT|external embedding provider 장애 시 row 단위 dead-letter|`EMBEDDING_PROVIDER`, `EMBEDDING_DIMENSIONS`, `BATCH_DATABASE_URL`|`weasley_deepmind_embedding_jobs_total`, batch pool|`scripts/post-migrate-flexible-embedding-dims.js`|
|`EmbeddingCache` (`lib/memory/embedding/EmbeddingCache.js`)|텍스트 hash|cache hit/miss|Redis 장애 시 noop|`CACHE_ENABLED`, `CACHE_DB_TTL`|`weasley_deepmind_embedding_cache_*`|—|
|`MorphemeIndex` (`lib/memory/embedding/MorphemeIndex.js`)|fragment 텍스트|morpheme 토큰 + 임베딩|형태소 분석 실패 시 fragment의 `morpheme_indexed=false` 유지|`MORPHEME_PROVIDER`, `MORPHEME_TIMEOUT_MS`|`weasley_deepmind_morpheme_index_*`|migration-035|
|`NLIClassifier` (`lib/memory/signals/NLIClassifier.js`)|premise/hypothesis 텍스트 쌍|entail / contradict / neutral 라벨|NLI 서비스 미도달 시 LLM fallback 또는 soft skip|`NLI_SERVICE_URL`, `NLI_TIMEOUT_MS`|`weasley_deepmind_nli_total`|—|
|`AutoReflect` (`lib/memory/processors/AutoReflect.js`)|long session events|reflect 파편 자동 생성|LLM 응답 파싱 실패 시 skip|`GEMINI_TIMEOUT_MS`, `AUTOREFLECT_ENABLED`|`weasley_deepmind_autoreflect_total`|—|
|`RecallSuggestionEngine` (`lib/memory/read/RecallSuggestionEngine.js`)|recall 응답 메타|`_meta.suggestion.recommendedTool` 권고|graph 신호 부재 시 suggestion 미발행|—|`weasley_deepmind_recall_suggestion_total`|—|
|`MemoryLinker` (`lib/memory/processors/MemoryLinker.js`)|fromId/toId/relationType|link 생성/모순 격리|cycle detection 거부, RLS 거부|—|`weasley_deepmind_link_create_total`|core schema|
|`MemoryReflector` (`lib/memory/processors/MemoryReflector.js`)|session reflect params|batchRemember 결과 + episode 생성|상속 (batch)|—|상속|—|
|`dispatchChain` (`lib/llm/index.js`)|provider chain + prompt + options + deps|첫 성공 provider 응답|429 cooldown, semaphore timeout, chain deadline|`LLM_PRIMARY`, `LLM_FALLBACKS`, `LLM_CHAIN_TIMEOUT_MS`, `LLM_CONCURRENCY_*`|`llm_provider_calls_total`, `llm_provider_latency_ms`, `llm_provider_concurrency_*`, `llm_provider_429_total`, `llm_fallback_triggered_total`|—|
|`SessionLinker` (`lib/memory/link/SessionLinker.js`)|session_id + 시간 인접 파편|temporal 링크|deadlock 회피 위해 sortedKey 정렬|`SESSION_LINKER_ENABLED`|`weasley_deepmind_session_link_total`|—|
|`SearchScope` (`lib/memory/read/SearchScope.js`)|sq (검색 쿼리 파라미터 객체)|검색 레이어별 scope 정합 객체 `(workspace, caseId, resolutionStatus, phase, affect, keyId)`|없음 (순수 변환)|—|—|—|
|`SearchSideEffects` (`lib/memory/read/SearchSideEffects.js`)|검색 결과 배열 + ctx|searchEventId, co_retrieved 업데이트, EMA 갱신|DB 장애 시 soft fail|—|`weasley_deepmind_search_event_total`|migration-027|
|`PgVectorStore` / `SqliteVecStore` (`lib/storage/`)|SQL 문 + 파라미터|rows 배열|연결 오류 시 throw; SqliteVecStore는 미구현 스텁|`WEASLEY_DEEPMIND_STORAGE`|—|—|

## Hot-cache recall consistency

`FragmentSearch` treats Redis hot payloads as candidate hints. Before ranking or
budgeting, it hydrates hits among at most 30 requested IDs through the existing
`FragmentReader.getByIds` and `queryWithAgentVector` path. Only the durable row's
content, validity and scope fields are used. This adds a bounded batch SELECT for
cache validation in addition to normal L2 reads; the shared database helper may
also perform transaction/session setup. There is no per-candidate SELECT loop or
database scan.

Default recall excludes inactive/deleted rows; `includeSuperseded: true` preserves
explicit historical candidates with durable `valid_to` values. Scalar keys, group
keys, empty groups, master access and peer-agent opt-in retain their existing
scoped-reader contract. Workspace and affect filtering run on hydrated rows.
The by-ID L1-miss fallback applies the same scope, including case, phase and
resolution status, so it cannot reintroduce a candidate rejected during hydration.
The separate `searchAsOf` path and the tool's `asOf`/`anchorTime` behavior are unchanged.

Absent or missed Redis entries require no validation read. If a populated cache
cannot be validated because the durable read fails, that error propagates; the
cache is not an offline source of truth. Thus even a hot-only result now requires
durable-read availability. Read validation also handles old payloads repopulated
after a mutation, without requiring every mutation path to delete every cache.

This does not promise linearizability for a read overlapping a concurrent mutation,
freshness of Redis candidate indexes, or exhaustive retrieval. Session Working Memory uses a separate durable hydration path in
`ContextBuilder`; see [working-memory freshness](validation/working-memory-freshness.md). The offline
`superseded-hot-cache-recall.test.js` regression covers restart/stale-refill scenarios,
amended-content budgets, history, scope and the reader's SQL bindings.

## Local embedding E2E cache

The weekly local-embedding workflow caches the installed Transformers.js default
directory after `npm ci`, using an OS/lockfile key. The locked 3.8.1 runtime stores
files under `node_modules/@huggingface/transformers/.cache`; the application does
not map `HF_HOME` to that path. Offline unit checks compare the workflow path with
the actual runtime and verify a tiny synthetic configuration survives across fresh
processes without network access. They do not load model weights or measure model
performance or GitHub cache-service behavior.

## 실험적 기능 플래그

다음 기능은 기본 off이며 ENV 토글로 활성화한다. 운영 신뢰가 확보되면 기본 on으로 승급할 후보다.

|기능|ENV|기본|분기 위치|비고|
|-|-|-|-|-|
|SpreadingActivation|`ENABLE_SPREADING_ACTIVATION=true`|off|`lib/memory/processors/MemoryRecaller.js`|recall 시 contextText 기반 graph 부스트. recall precision 개선치 확보 후 기본 on 승급 검토|
|CaseRewardBackprop|`WEASLEY_DEEPMIND_CASE_BACKPROP_ENABLED=true`|off|`lib/memory/signals/CaseRewardBackprop.js` (호출 시점 매번 평가, 런타임 토글 가능)|case verification 결과를 증거 파편 importance에 역전파. 비활성 시 호출 자체가 no-op (DB·메트릭 영향 0). DAG 일관성 베이스라인 확보 후 승급 검토|

## 실험 플래그 아닌 dual-mode·항상 활성 기능

다음 기능은 ENV로 on/off 토글되는 실험이 아니라 운영 기본 흐름의 일부다. ENV는 동작 모드 분기에 사용된다.

|기능|ENV|동작|
|-|-|-|
|HNSW 인덱스 강제 검색|—|벡터 검색 트랜잭션 시작 시 `SET LOCAL enable_seqscan = off`, `SET LOCAL enable_bitmapscan = off`, `SET LOCAL hnsw.iterative_scan = relaxed_order` 적용. planner가 seqscan·bitmap scan으로 우회하는 것을 차단하여 HNSW index scan 경로를 강제하며, 필터 조건이 붙는 쿼리에서 308ms→7ms 단축 확인. `lib/tools/db.js` L3 검색 경로 고정|
|NLIClassifier|`NLI_SERVICE_URL`|설정 시 외부 HTTP 서비스 호출, 미설정 시 in-process ONNX 모델로 동일 분류를 수행. 항상 활성|
|AutoReflect|—|`sessions.js`의 세션 종료/회전 흐름에서 자동 호출. 비활성화하면 세션 학습이 손실되므로 운영에서 항상 활성|
|ReconsolidationEngine|—|`tools/memory.js`의 `tool_feedback`이 직접 호출하는 핵심 경로. ENV 게이트로 막지 않는다|
|storage 어댑터|`WEASLEY_DEEPMIND_STORAGE`|`pgvector`(기본) → `PgVectorStore` / `sqlite-vec` → `SqliteVecStore`. `getStorage()` 팩토리가 반환 타입을 결정. 호출 사이트 마이그레이션은 향후 점진 수행 예정|
|recall 적응형 임계값 하한|`WEASLEY_DEEPMIND_RECALL_MIN_SIM_FLOOR`|미설정 시 `SearchParamAdaptor.getMinSimilarity`의 반환값을 그대로 사용. 설정 시 `Math.max(floor, learned)`로 하한 강제. 한국어 long-tail query에서 노이즈 fragment 통과를 차단|

## 새 모듈 추가 규약

1. 모듈을 `lib/memory/` 또는 적절한 도메인 디렉토리에 신설한다.
2. 본 표에 행을 추가한다. 컬럼 7개 모두 채운다(없으면 `—`).
3. 새 ENV가 도입되면 `docs/configuration.md`에도 반영한다.
4. 새 메트릭이 도입되면 `lib/metrics.js`에 등록되었는지 확인하고 본 표에 메트릭 이름을 적는다.
5. migration이 따라오면 `lib/memory/migrations/migration-*.sql` 번호와 본 표 행을 연결한다.
6. PR 템플릿(있다면)의 features ledger 체크박스에 체크한다.


## Working Memory context freshness

`ContextBuilder` treats session Redis entries as candidate IDs and rehydrates them
through `FragmentReader.getByIds` with existing agent/key/group scope, then filters
current workspace, validity and anchor state. Each query contains at most 30 IDs;
durable failures propagate rather than injecting stale payloads. See
[validation and limits](validation/working-memory-freshness.md).

## Link read lifecycle

`LinkStore` linked recall and RCA edge reads, and `LinkedFragmentLoader` attached previews, exclude `fragment_links.deleted_at IS NOT NULL` before limiting candidates. This does not remove the fragment itself from direct search, repair `linked_to` adjacency, or change key/agent/workspace policy. Validation and limits: [active-link-recall](validation/active-link-recall.md).

## Cyclic causal history

`HistoryReconstructor` traverses natural roots first, then uncovered causal source
IDs so stored rootless cycles and self-loops remain represented in
`causal_chains`. Each traversal visits a node once; distinct natural roots keep
their existing shared-tail behavior. The fallback representative follows input
link order: `root_id` is a traversal start, not proof of an acyclic causal origin.
This is evidence preservation, not cycle repair, strongly connected component
decomposition, or a change to the existing resolution heuristic. Query scope,
link deletion filters and event-to-fragment projection are unchanged. Regression:
`tests/unit/history-causal-components.test.js` exercises production reconstruction
with synthetic timeline/link boundaries; it does not validate live storage.
