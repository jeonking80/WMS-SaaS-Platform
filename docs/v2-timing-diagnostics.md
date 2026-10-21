# WMS 서버 단계 진단

현재 실패 런의 원문·journal·최종 대사 결과를 보존한 뒤, 별도 시험 복제본에 사용하는 opt-in 계측이다. 기존 성능 실패를 대체하거나 합격 기준을 바꾸지 않는다. 후속 별도 schema-19 복제본에서 bounded 진단을 실행했으며, 결과는 [v2-timing-bounded-results.md](v2-timing-bounded-results.md)에 기록했다. 원래 부하 런의 실패 판정은 유지한다.

`WMS_TIMING_DIAGNOSTICS=1`과 `WMS_ENVIRONMENT=test`가 모두 필요하다. 기본 OFF이며 production 환경에서는 활성화하지 않는다. 풀 크기·SQL·잠금 순서·업무 입력·멱등키·응답·오류 처리·telemetry 저장 의미는 유지한다. 비활성 경로의 비동기 타이머는 원래 Promise를 그대로 반환한다.

활성 요청은 `wms_timing_diagnostic` 집계 JSON을 하나 남긴다. 고정 allowlist의 작업/단계명과 ms·개수·bytes만 포함하며, 요청 ID·회사/사용자/업무 ID·SQL/인자·오류 원문·원문 응답·본문·헤더·인증 자료는 받거나 저장하지 않는다. 정상 API 로그의 기존 정책과 별개인 진단 출력이다. 진단 출력 장애는 업무 결과를 바꾸지 않는다.

| 단계 | 의미 |
| --- | --- |
| `db.pool_acquire`, `telemetry.pool_acquire` | 연결 획득 대기. pool 사용/유휴/대기 최대 수와 표본 수를 별도 기록 |
| `db.connection_held`, `telemetry.connection_held` | 획득 후 release까지. BEGIN/context/operation/commit/rollback은 별도 하위 단계 |
| `workflow.request_lock`, `workflow.warehouse_lock`, `workflow.state_initialize`, `workflow.state_lock_read` | 현재 잠금/상태 조회 경계의 await. state 조회는 원래 pg JSON 파서를 유지 |
| `workflow.references`, `workflow.stock_read`, `workflow.persist_sql`, `workflow.snapshot_sql` | 분류된 조회/저장 await. 모든 SQL을 계측한 것은 아니므로 남는 시간을 순수 CPU로 간주하지 않음 |
| `workflow.state_clone`, `workflow.snapshot_clone`, `workflow.persist_json` | 기존 clone/직렬화 호출만 감쌈. 저장 JSON은 한 번만 생성하고 같은 문자열을 SQL에 전달 |
| `workflow.engine`, `workflow.reconcile`, `workflow.snapshot_reconcile` | 엔진 전체 및 내부/응답 대사. clone·대사와 엔진은 중첩되는 포함 시간 |
| `workflow.aggregate_match`, `workflow.persisted_reconcile` | 기존 재고 대조 및 전체 원장 대사. 내부 쿼리 시간을 포함 |
| `workflow.actor_names`, `workflow.legacy_hydrate`, `workflow.scans`, `workflow.request_hash` | 이름 보강·기존 과납 이력 복구·스캔 검증·요청 해시의 기존 처리 유지 |
| `integration.batch`, `integration.event` | HTTP 요청 내 최대 50건 batch 및 사건별 처리. 사건 단계는 connection commit/rollback을 포함하지 않음 |
| `integration.source_authorization`, `integration.resolve`, `integration.queue_sql`, `integration.entity_sql`, `integration.entity_lock`, `integration.status_sql` | 같은 연결의 키 재검사와 사건 선택/엔티티/결과 저장. 업무 입력·키 수량·처리 순서는 유지 |
| `request.handler`, `http.body_parse`, `http.json_response`, `request.telemetry` | handler·기존 본문 파싱·Response.json·응답 반환 전 지표 저장 대기 |

각 span은 `count`, `failed_count`, `inclusive_ms`, `max_ms`다. 중첩 span을 더해서 비율로 계산하면 안 된다. 쿼리 await에는 DB 실행/잠금/네트워크/기본 JSON 파싱/이벤트 루프 대기가 섞여 있다. 이번 구현은 text cast/수동 JSON.parse/global PG parser 변경을 하지 않으므로 파싱 시간을 독립 수치로 주장하지 않는다. 실제 잠금 비중이 필요하면 후속 격리 진단에서 별도 읽기 전용 관측을 붙이고 측정 한계를 명시해야 한다. 연계 사건의 commit 이후 applied/business_rejected/dependency_wait/retry_wait/quarantined 건수를 별도 고정 label로 기록하므로 내부에서 처리한 업무 거절/기술 재시도가 HTTP 200에 가려지지 않는다.

`workflow.state_json` bytes는 기존에 만든 문자열에서 계산한다. 업무 객체 개수는 이미 있는 배열 길이만 읽는다. 원장/주문을 추가 조회하거나 전체 객체를 다시 stringify해서 크기를 계산하지 않는다. 응답 body bytes는 이번에 측정하지 않는다.

`request_elapsed_ms`는 telemetry를 기다린 뒤, 진단 출력과 실제 HTTP 전송 전에 끝난다. 기존 durable `durationMs`는 telemetry 전에 계산하는 의미를 그대로 유지한다. 클라이언트 본문 수신/JSON 완료 시간과 혼동하지 않는다. `request_failed_count`는 handler 밖으로 탈출한 예외 수이며, HTTP 오류 응답은 `http.error_responses`와 `http.status` 숫자로 별도 기록한다. API가 오류를 정상적으로 응답한 경우에도 오류 수가 사라지지 않는다.

계측 비용은 `timer_calls`, `bookkeeping_ms`, `collector_finalize_ms`를 남긴다. 이는 전체 관측 비용의 추정치가 아니라 집계 갱신/레코드 조립의 일부 비용이며, 타이머 호출·활성 ALS·closure/Promise·크기 계산·출력 비용은 완전히 분리 측정하지 않는다. 출력 자체의 지연은 `logging_overhead_measured=false`로 명시하고 성능 수치에서 임의로 빼지 않는다. 별도 DB 쿼리와 업무 payload 추가 직렬화는 0이다.

회귀 테스트는 기본 OFF/production 차단·결과/Promise 보존·고정 label과 민감값 비출력·예외 보존·동시 요청 ALS 격리·JSON 한 번 직렬화·진단 출력 실패를 다룬다. 후속 복제본의 소량 순차 요청 관측은 별도 결과 문서에 기록했다. 원래 동시 부하의 지연 비중과 계측 OFF 대비 비용은 이 관측만으로 확정하지 않는다.
