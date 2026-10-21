# WMS v2 외부 사건 계약

계약 버전 `2.0`, 기획 기준 v1.1. 회사는 Bearer machine key로만 결정한다. source key는 `kind=integration`, 허용 창고 및 `integration:event,integration:read` scope로 발급한다. 별도 처리 키는 `integration:process`만 가진다. 실제 실물 작업·승인은 서로 다른 `kind=automation` 계정의 `write`/`approve` 권한으로만 처리한다.

`POST /api/v2/integration/events`:

```json
{"schema_version":"2.0","event_id":"UUID","source_system":"SUPPLIER","external_entity_id":"PO-100","revision":1,"event_type":"receipt.create","occurred_at":"2026-10-20T00:00:00Z","correlation_id":"trace-100","run_id":"optional-test-run","warehouse_id":"UUID","payload":{"lines":[{"item_id":"UUID","quantity":100}]}}
```

사건 종류는 `receipt.create/update/cancel`, `order.create/update/cancel`, `shipment.delivery`, `return.request`. payload는 [업무 계약](v2-workflow-contract.md)의 해당 명령을 따른다. 입고/주문 수정·취소의 내부 object ID는 외부번호 매핑으로 서버가 바인딩한다. 생성 external_id는 `source_system:external_entity_id`. 배송/반품은 실제 인계로 생성된 `shipment_id`를 참조하며, 외부 사건이 출하 실적을 생성하지 않는다. 기준정보는 별도 준비 권한과 [기준정보 API](v2-masters-contract.md)로 준비한다.

접수 응답 `202 {event,replayed}`는 DB COMMIT 이후에만 반환하며 업무 반영 성공을 의미하지 않는다. 같은 회사·원천·event_id와 같은 canonical SHA256은 같은 접수 ID를 반환한다. 다른 내용은409. 다른 event_id라도 같은 회사·원천·객체종류·외부번호·revision은 semantic hash가 같으면 기존 접수를 반환하고 다르면409. 원래 접수 ID와 외부 유일식별자는 삭제하지 않는다.

`GET /api/v2/integration/events?warehouse_id=UUID&event_id=UUID`는 event_id 또는 접수 id로 원결과를 조회한다. `external_entity_id`(별칭 `external_id`)와 `source_system`은 정확히 일치하는 결과를 검색한다. `status`는 accepted/dependency_wait/applied/business_rejected/retry_wait/quarantined 중 쉼표로 구분한 복수 상태를 받는다. `limit`은 1~100(기본100), `cursor`는 불변 접수 sequence이며 오름차순으로 조회한다. cursor는 접수 목록 페이지용이다. 이미 접수한 사건의 변경 결과는 해당 event_id로 계속 폴링한다.

응답은 `{events,cursor,has_more,total_count,filtered_count,status_counts}`다. `total_count`와 6개 상태별 `status_counts`는 회사·창고·원천·사건·외부번호 검색 전체에 적용하며 상태 선택과 cursor를 제외한다. `filtered_count`는 선택한 상태까지 적용한 전체 건수이며 cursor를 제외한다. 페이지와 전체 집계는 같은 SQL 문장의 스냅샷으로 계산한다. 빈 페이지는 입력 cursor를 유지한다. 따라서 앞100건이 적용 완료여도 101번째 격리 사건을 오류 필터와 전체 집계에서 찾을 수 있다.

machine key는 자기 source 결과만 조회하고 다른 `source_system`을 지정하면 403이다. session 사용자는 허용 회사·창고 범위만 조회한다. 원문 전체·credential은 반환하지 않는다. 잘못된 상태·limit·cursor(bigint 범위 초과 포함)와 서로 다른 두 외부번호 별칭은 400이다.

상태: `accepted`, `dependency_wait`, `applied`, `business_rejected`, `retry_wait`, `quarantined`. 누락 revision은 앞선 revision이 도착할 때까지 대기한다. 업무 거절도 revision을 소비하며 수정한 의도는 새 revision으로 보낸다. 배송/반품의 아직 없는 원출하는 의존성 대기다. 이전 revision과 중복은 업무 상태를 되돌리지 않는다.

`POST /api/v2/integration/process {warehouse_id,limit:1..50}`는 명시적인 처리 권한만 허용한다. DB 대기열에서 대상을 잠그고 외부객체 revision·업무aggregate·정규재고·원장·멱등결과·사건결과를 같은 트랜잭션에 확정한다. workflow는 별도 COMMIT하지 않는다. source key의 현재 회수·만료·scope·시험환경·회사·창고도 반영 직전에 다시 확인한다. SQL/기술 실패는 savepoint로 업무 효과를 되돌리고 재처리 일정을 DB에 기록한다. 최초 이후 기본5회, 지수 지연+jitter 최대30초, 소진시 격리. 프로세스 종료로 접수 사건이나 일정이 사라지지 않는다.

응답은 `{events}`이며 `limit`은 이번 호출의 최대 처리 건수다(기본25, 최대50). 처리 함수 진입 이후 단조 시계 기준 5초가 지나면 완료한 사건 트랜잭션 사이에서 다음 사건 선택을 중단한다. 첫 트랜잭션은 항상 시도하고 이미 시작한 사건은 커밋 또는 롤백을 마칠 때까지 기다린다. 선택하지 않은 사건은 기존 상태·시도 횟수·재처리 일정으로 DB에 남는다. 따라서 `events.length < limit`은 대기열이 비었다는 뜻이 아니며 시간 예산 소진이나 잠금 경합으로도 발생할 수 있다. 남은 사건은 후속 처리 호출과 사건 결과 조회로 확인한다. 이 예산은 요청 시간 상한이 아니다. 처리 함수 이전의 인증·권한 확인과 응답 전송은 예산 밖이며, 진행 중인 사건의 풀·잠금 대기와 처리·커밋·롤백은 5초를 넘겨도 중단하지 않으므로 HTTP 응답 시간이나 클라이언트 타임아웃 내 완료를 보장하지 않는다.

`POST /api/v2/integration/events/{receiptId}/retry {warehouse_id}`는 처리 권한/운영 책임자만 가능하며 기존 사건과 키로 격리·의존성대기·재처리대기를 재개한다. 적용완료/업무거절을 다시 업무로 만들지 않는다. 세션 mutation은 같은 origin을 요구한다.

회사별 `v2_integration_limits`의 기본치는 분당 신규600건, 비최종 대기10000건이다. 모든 원천이 같은 행 잠금으로 예산을 공유한다. 한도 초과는429와 `Retry-After`를 반환한다. 동일 요청 replay는 새 예산을 소비하지 않는다. 처리기는 창고별 advisory transaction lock을 사용하여 같은 창고를 여러 인스턴스가 중복 실행하지 않는다.

별도 상주 프로세스:

```bash
WMS_URL=http://127.0.0.1:3000 \
WMS_INTEGRATION_PROCESS_KEY='<processing-key>' \
WMS_INTEGRATION_WAREHOUSE_IDS='<warehouse-uuid>,<another-warehouse>' \
node src/server/v2/integration/worker.mjs
```

배포 secret binding을 사용하고 명령·로그·보고서에 실제 key를 남기지 않는다. 이 프로세스는 API만 호출한다. supervisor가 프로세스를 재시작해도 미완료 업무는 DB 대기열에서 복구한다. 실제 상용 scheduler/상주 호스팅의 선정·가용성 검증은 별도 운영 게이트다.

`GET /api/v2/integration/connection`은 회사·시험회사 여부·환경·source·허용창고·계약버전을 반환한다. 시뮬레이터는 URL/회사/환경/source/창고 목록을 고정 fingerprint로 저장하고 재개 전에 비교한다. 운영 환경/회사는 시험키와 자동작업 계정을 서버에서도 차단한다.
