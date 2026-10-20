# WMS v2 독립 요구사항·gap 감사

기준: [현장 운영 기획서 v1.1](WMS-현장운영-고도화-기획서.md). 감사일 2026-10-20. 이 문서는 원본 기획의 범위·수락 기준을 축소하거나 전체 완료를 선언하지 않는다. 개발 중 소스를 읽고 API/UI/시뮬레이터/검사를 대조한 기록이다. 아래의 **경로·검사 존재**는 기능·예외의 해당 구현과 검사가 있다는 뜻이며 G2/G3/G4 통과의 대체 표현이 아니다. 실제 실행 결과는 별도 검증 기록과 함께 판정해야 한다.

최신 workflow 표적 검증은 TypeScript 오류 0, 단위 11개, 실제 PostgreSQL 12개 통과다. 요청자·원실적자·전체 계수자의 승인 분리, 배송 정정의 무재고효과, 포장 무게, 보류 반납의 재작업, 주소 스냅샷 보존을 포함한다. 다른 담당자의 전체 회귀는 별도 실행 기록을 따른다. 아래 운영 시나리오 결과는 저장된 실제 HTTP/SQLite 보고서를 읽어 대조했으며, 이 감사 자체가 전체 빌드·공개 배포·8시간 시험을 새로 실행했다는 뜻은 아니다.

## 판정상 중요한 차이

- 코드가 있는 경로, 자동 검사가 있는 경로, 실제 현장/배포 검증을 구분한다. 실제 사람·실기기·호스팅 복구·교대 부하의 미실행을 자동 테스트로 완료 처리하지 않는다.
- 감사 중 발견된 담당자 우회, 부분수령 예정 취소의 승인 우회, 스캔 모드 생략, 최근 100행만 대사하던 시뮬레이터, CSV 코드 해석 불일치, 원본 없는 정정은 보강 코드가 추가됐다. 최종 소스의 통합 회귀는 계속 확인해야 한다.
- 예정/주문 필수 기본정보는 UI에서 요구하는 것과 API에서 강제하는 것이 달랐다. 현재 receipt의 active supplier/expected_at, order의 active customer/소속 delivery destination/due_at를 workflow API가 강제하고 실제 배송지 스냅샷을 저장한다. CSV도 같은 필수 코드와 날짜를 요구하며 masters PostgreSQL 12개가 통과했다. 최신 전체 회귀 결과는 별도 상위 검증 기록을 따른다.
- 운영 지표는 관측 분모·기간을 공개한다. 피킹 스캔 거절 비율은 서버 검증 거절 / order.pick API 요청이며 실물 오피킹률과 동일하지 않다. 0/0은 no_samples이고 측정 수단이 없으면 not_measured다.

운영 알림은 [v2-alert-delivery.mjs](../scripts/v2-alert-delivery.mjs)의 HTTPS webhook과 비공개 SQLite outbox로 보강됐다. 업무번호·요청 ID·서버 권한을 재확인하는 조치 링크를 허용 목록으로 구성하고 재시도·중복 억제·실패 재대기 경로를 제공한다. 단위 검사는 존재하지만 실제 운영 수신자 설정·전달·사람의 확인 증거는 별도다. HTTP 수신 성공은 담당자 확인 완료를 뜻하지 않는다.

## 필수 요구사항 28개

| ID | 현재 확인한 실제 경로·근거 | 잔여 범위·판정 제한 |
| --- | --- | --- |
| IAM-01 | [access.ts](../src/server/v2/access.ts), [identity/service.ts](../src/server/v2/identity/service.ts), identity UI, v2-identity PG 검사. 최초 회사·관리자는 [provision-company.mjs](../scripts/provision-company.mjs)의 별도 운영 경로와 발급 감사 기록. | 최초 발급·실사용 계정 전달·공용단말 정책을 실제 운영 환경에서 확인해야 함. |
| IAM-02 | role/scope 재확인, 링크·키 회수/교체, 불변 performance·audit. 요청자와 원실적자 및 모든 실사 계수자를 별도 보존하고 자기 승인을 거절하는 PG 회귀 통과. | 최종 세션/역할/창고·UI 통합 회귀와 현장 권한 운영 확인 필요. |
| MD-01 | [migration 12](../db/migrations/1792368000012_v2-masters.sql), masters API/UI: 공급/납품 역할, 배송지 외부코드, 위치 5유형, 사용 중 비활성 차단. | 실제 기준정보 이관과 현장 위치 정책 확인 필요. |
| MD-02 | tenant 고유 immutable barcode, EA/BOX 고정 정수 환산, 서버 resolveBarcode, 불변 performance.conversion. 라벨 Code128 출력과 반복 스캔 UI. | 과거 환산 증거의 일반 사용자 조회/출력 범위를 끝까지 확인해야 함. 실스캐너 검증은 미실행. |
| MD-03 | masters/business CSV preview→행 오류→선택 apply, 같은 키/다른 키 중복 방지, 코드→활성 참조 해석, 정상 문서 그룹 원자 처리, master formula-safe export. | 신규 원장 전체 내보내기/페이징을 포함한 최종 UI 회귀와 대량 결과 검증 필요. |
| IN-01 | engine receipt.create/update/cancel/close.request 및 입고 UI. 미수령 취소와 부분수령 후 승인 마감 분리 보강. | 공급처·예정시각 필수 강제와 CSV 12개 PG 검증 반영. 실제 현장 운영 확인 필요. |
| IN-02 | receive의 Q/B 원자 반영, 검수 normal/hold, 과납 승인/반려·해제, 수령 식별자 별도 고유성. AC-01/02/21 PG 검사. | 실물 과납/파손 현장 확인과 반송 운영 결정은 별도. |
| IN-03 | 분할 putaway, STORAGE 유형 제한, UI 우선순위 후보, 위치/품목 대조. | 추천은 위치 우선순위 기반이며 실제 현장 추천 정책의 적합성은 미검증. |
| OUT-01 | order.create/update/cancel, due_at, 원주문 보존, 연결 추가주문, 잔량 표시. | 고객·소속 배송지·납기 필수 강제. 완료 포장/출하 주소는 보존하고 미포장 잔량 기본주소 변경을 허용하는 PG 회귀 통과. 실제 현장 운영 확인 필요. |
| OUT-02 | 창고 aggregate 잠금과 R≤S, 전체/명시적 부분 예약, 위치 우선순위·차단, 부족 재실행. AC-03/04 검사. | 10명 작업자·장기 혼잡 환경 성능은 별도 시험. |
| OUT-03 | task.assign, 현재 담당자 및 package/shipment 간접 참조 검사 보강, pick/shortage/damage·대체 피킹, scan 검증. | 여러 단계·다른 담당자로의 인계 UI와 새 강제 규칙을 함께 재검증해야 함. |
| OUT-04 | package source pick별 명세 보존, 20명세 검사, 완료 포장 전체 handover, 운송/인계자 및 스냅샷. AC-05/22/23 검사. | 선택 무게는 양의 정수 g로 저장·표시하며 잘못된 무게 거절 PG 검사 통과. 실기기 출력은 별도 확인. |
| OUT-05 | 일반 배송 사건과 책임자 전용 shipment.delivery.correct를 분리. 정정 사유·이전/새 revision·상태·주체·요청 이력, 종결 후 일반 기록 차단 및 재고/원장 무효과 PG 검사 통과. | 실제 운송사 사건 계약과 정정 운영 연계 검증은 별도. |
| INV-01 | 정규 S/R/P/Q/B와 A/H 계산, 실제 원장 독립 대사, 실사/위치 차단 가용 제외. | 상태 전체를 합친 실제 장시간 부하/누적량 동시 쓰기 시험은 미실행. |
| INV-02 | stock.move/hold, 품질보류·승인된 과납 release, 재검수/적치, 이동 양면 원장. 파손 피킹·취소 반납 B에도 추적 lot을 생성해 해제→검수→적치 PG 회귀 통과. | 수령/이동/반납 각각의 현장 위치 스캔과 승인 정책 확인 필요. |
| INV-03 | 위치 잠금, blind count, 20행씩 누적 계수, 차이 재계수/타인 승인, force unlock 후 구승인 거절. | 모든 계수자와 제출자를 별도 기록하고 이들 전원의 자기 승인 차단 PG 회귀 통과. 실제 계수 UX는 현장 확인 대상. |
| RET-01 | 원출하행 연결, 반품 승인 점유/실수령/잔량 마감, inspect/putaway, 연결 재배송 주문. | T05 실제 HTTP 부분도착·미도착 마감·정상/보류 검사와 독립 대사 통과. 실제 고객 승인·재반품 운영 표본은 별도. |
| COR-01 | [corrections.ts](../src/server/v2/workflow/corrections.ts)의 실존 원장·반대 효과·누적 한도·후속 작업 검사, 요청/승인 이중 검사 보강. | 기존 stock_ledger/확정전표를 원본으로 선택해 확인된 cutover 품질·위치 매핑 안에서 보상한다. 구전표·구원장 불변, 원실적자 승인 금지 PG 회귀 통과. 실제 운영 표본 확인 필요. |
| UX-01 | 단계 연속 이동, 잔량/다음 작업, 검색 대체 사유, 사용자별 복구 키, 오프라인 확정 차단, terminal lock 정책/화면. v2-ui browser 검사 존재. | AC-15 신규 사람·실기기 실습 및 재검색/왕복/도움 요청 관찰 기록은 미실행. |
| OPS-01 | 재고/승인/연계 대기열, [ledger-ui.tsx](../src/app/dashboard/v2/ledger-ui.tsx)의 고정 경계 전체 조회/CSV, [monitor](../src/server/v2/operations/monitor.ts)의 KPI·low A·오류율/p95. | 최근 보강 전체 조회/출력의 현장 회귀, 경보 전달 및 운영지원 연동은 별도. |
| OPS-02 | shift.close의 기준 시각 보고서, 미처리 인계와 새 담당 이력, 실제 원장 대사, 보고서 CSV. | 실제 8시간 교대·책임자 인계 실습, 마감 후 재개와 지연 실적 확인 필요. |
| INT-01 | tenant/source/env/scope key, tenant/kind/external object unique, durable event receipt와 body hash, workflow request/receiving unique. | 실제 외부 채널 연결은 범위 밖이며 시험 연결 대상 변경 차단은 검사를 유지해야 함. |
| INT-02 | revision 의존성 대기, 사업 거절/기술 재시도/격리, source 결과 조회, rate/queue 제한, 재처리 worker. | T09 실제 simulator SIGKILL 2회·SQLite 재개, 429/503 Retry-After, commit 후 응답 유실·원접수 확인 보고서 통과. WMS 서버 강제 종료·다중 인스턴스·실제 네트워크 차단은 별도. |
| SIM-01 | 독립 [simulator](../apps/simulator/), SQLite 저장소, 가상 사건/작업 계획, test target 검사. | T01~08/T10 전용 실제 API 시나리오, T09 장애 harness, T11 coordinator와 로컬 T12 복원 재개가 추가됐다. T01~12의 모든 조합·현장 운영을 대체하지 못함. |
| SIM-02 | human/auto/mixed, seed, durable body/key/checkpoint, pause/resume, 대상 fingerprint 변경 차단. | T09 실제 simulator 중단/재개와 짧은 혼잡·인계 프로필은 보고서가 있다. 10명·8시간 전체 프로필 및 지정 25분 혼잡 완주는 별도 판정. |
| SIM-03 | WMS 코드를 가져오지 않는 oracle, 로컬 intent→실재고/전체 원장/예약 대사, version 경계, 누계/API 호출/p95 보고서. | T01~08 및T10의 지정 API 흐름과 독립 원장/재고 대사 보고서가 있다. 13장 전체 시간·입력량 프로필, 현장 다중 작업자 판정은 별도. |
| RUN-01 | read-only 모니터 CLI/API, request telemetry, queue/예약/재고/백업 점검, 확대된 로컬 복원 스크립트. | 18 migration/40 table의 synthetic local 복원과 로컬 HTTP 기존 키·예약·업무 재개 보고서가 있다. 원격 제공자 PITR/7일 보관·비용, RPO15분/RTO2시간, 경보 수신/지원 담당자·재개 승인 확인은 미실행/unknown. |
| MIG-01 | 첫 10개 migration 보존, [cutover.ts](../src/server/v2/operations/cutover.ts)의 해시/대사/품질 매핑·legacy 쓰기 차단. [opening-import.ts](../src/server/v2/operations/opening-import.ts)는 외부 CSV·추출시각·오류·코드 매핑·원본 해시를 보존하고 빈 창고에 타관리자 승인 후 EXTERNAL_OPENING을 반영한다. 기존잔량 중복 반영은 거절한다. | 외부 개시 이관 표적 PG 8개 통과는 상위 담당자 기록 기준. 실제 MVP 사본 전환·실패복구 리허설과 운영 원본 정정 표본 확인 필요. |

## 수락 기준 AC-01~23 대조

| AC | 구현/검사 근거 | 남는 판정 |
| --- | --- | --- |
| 01 | v2-acceptance.test.ts 부분수령·재전송 | 표준 수치 자동 검사 존재. |
| 02 | 같은 파일 정상/보류·분할적치 | 표준 수치 자동 검사 존재. |
| 03 | 같은 파일 동시 전체예약/명시적 부분예약 | DB 경쟁 검사 존재; 운영 부하는 별도. |
| 04 | 같은 파일 pick S/R/P와 retry | 표준 효과 검사 존재. |
| 05 | 같은 파일 15/5 포장·일부 포장 전체 인계 | 표준 효과 검사 존재. |
| 06 | 같은 파일 취소/출하 경쟁 및 unit 취소반납 | 포장해제·실물반납 검사 존재. |
| 07 | 같은 파일 반품5/수령3/마감2, simulator returns | 실제 고객 반품 표본은 미실행. |
| 08 | 예약/후속 작업 차단 및 corrections 보강 | 신규 corrections/legacy 경로 최종 통합 회귀 확인 필요. |
| 09 | 늦은 행 오류, durable response 장애, 키 충돌 PG 검사 | 실제 호스팅 프로세스 강제 종료와는 구분. |
| 10 | 위치 잠금·재계수·다른 승인·unlock stale 검사 | 실제 계수 실습은 별도. |
| 11 | v2-workflow PG conversion 증거 및 v2-ui BOX12 반복 스캔 검사 | 실스캐너/인쇄·과거 환산 조회 실제 확인 필요. |
| 12 | v2-integration PG revision3→1→2/내용 충돌/중복 접수 | 외부 계약 시험 경로 있음. |
| 13 | SQLite 재개 단위 검사와 실제 handler+PG simulator 연결 검사 | T09 simulator SIGKILL 2회 및 별도 실제 WMS SIGKILL/새 PID 재기동 후 accepted 원사건 보존·재전송효과1회·독립 대사 차이0 통과(v2-wms-process-restart-latest.json). |
| 14 | v2-identity/legacy-scope/integration PG 및 HTTP acceptance | T10 두 회사 동일 코드·회사/창고 격리·실제 로그인/키 발급/회수 다음 요청 차단 보고서 통과. 실제 운영 권한 변경 관찰은 별도. |
| 15 | v2-ui browser 정상 연속 수령→출하 1개 검사 | **신규 사람·실기기·부분잔량·인계·부족 실습/관찰 기록 미실행.** |
| 16 | verify-restore.mjs synthetic local fixture 전테이블 보존 확대 | **provider_recovery NOT_EXECUTED, 실제 RPO/RTO 미측정.** |
| 17 | v2-cutover.test.ts 보존/매핑/legacy 차단/실패 rollback | 실제 운영 사본과 장애 복구 재개 리허설 별도. |
| 18 | v2-identity 초대/만료/재발급/마지막 관리자/세션 검사, terminal lock 보강 | 새 단말 잠금·교대 UX와 승인 변경 통합 회귀 필요. |
| 19 | v2-masters PG preview/선택/재전송/충돌 rollback/코드 A/B/수식안전 | 필수 기본정보/회사별 코드 해석 CSV PG 12개 통과. UI 최신 회귀와 현장 CSV 확인 별도. |
| 20 | v2-acceptance handover/미확인 거절/마감 보고서와 담당이력 보강 | 실제 교대/마감 이후 후속 실적 운영 관찰 필요. |
| 21 | v2-acceptance 과납 승인 및 반려 별도 검사 | 표준 Q100/B5/H105/A0 자동 검사 존재. |
| 22 | v2-acceptance 20/21 및 실제 API T03 원행21개·20+1/12+9 | 표준 명세 한도와 연속 분할 출하 보고서 통과. 현장 확인 별도. |
| 23 | unit/acceptance/simulator damage 독립 기대값 | 숫자 시나리오 경로 있음; 현장 파손·대체 실습 별도. |

관련 검사: [v2-acceptance PG](../tests/integration/v2-acceptance.test.ts), [v2-workflow PG](../tests/integration/v2-workflow.test.ts), [v2-identity PG](../tests/integration/v2-identity.test.ts), [v2-integration PG](../tests/integration/v2-integration.test.ts), [v2-masters PG](../tests/integration/v2-masters.test.ts), [v2-cutover PG](../tests/integration/v2-cutover.test.ts), [v2-ui browser](../tests/e2e/v2-ui.spec.ts), [v2 HTTP browser](../tests/e2e/v2-acceptance.spec.ts). 위 표는 검사 소스의 대응이며 이 문서만으로 전부 PASS를 선언하지 않는다.

## 운영 시나리오 T01~T12

| T | 현재 자동화 범위 | 누락/미실행 범위 |
| --- | --- | --- |
| T01 | 전용 실제 HTTP에서 부분40→추가65의 Q100/B5/H105, 독립 과납 승인·반려, 정상/파손 검수와 두 위치 분할 적치, 미승인/반려 해제 거절 및 원장 대사 통과. | 사람·실물 과납/파손 실습은 별도. |
| T02 | 실제 동시 HTTP 예약에서50개 재고에40개씩 요청한 두 주문의 승자1·부족1, 명시 부분예약10·부족30 추적→입고30→명시 재예약30·최종R80/S80 통과. | 실제 장시간 경합 부하는 별도. |
| T03 | 전용 실제 API 실행에서 동일 SKU의 서로 다른 원행21개, 20+1 및12+9 포장/다차수 출하, 21명세 무효과 거절·독립 대사 통과. | 실물 현장/출력 확인은 별도. |
| T04 | 전용 실제 API 실행에서 미예약/예약/피킹/포장/인계 이후 5단계 취소·반납·출하 거절 및 독립 대사 통과. | 현장 취소/반납 운영은 별도. |
| T05 | 실제 HTTP 배송실패/반품요청은 H0 유지, 승인5 중 실도착3만 Q/H 증가, 미도착2 마감·정상2/보류1 검수와 적치·독립 원장 대사 통과. | 실제 운송/현장 반품 운영은 미실행. |
| T06 | 실제 HTTP 오품목/오위치 스캔 무효과→부족 예약해제/위치차단→재계수·타인승인으로S-1→포장중 파손 해제/격리2→재입고1/대체피킹2→정상10 출하·B2 보존과 독립 원장 대사 통과. | 현장 파손/실사 실습과 실스캐너 확인은 별도. |
| T07 | 실제 HTTP 동일 event/새 event의 같은 revision 중복 접수, commit 응답 클라이언트 폐기 후 원키 조회, 같은/새 request 키의 동일 수령105 중복차단, 과납B5 1회, 포장/출하 중복 무효과·독립 대사 통과. | 클라이언트 응답 폐기는 실제 통신선 장애와 구분. 장시간 반복은 별도. |
| T08 | 실제 HTTP revision3→1→2 수신/1→2→3 반영, 누락 의존성대기, 과거 중복 무역행, event/revision 내용충돌, 잘못된 품목·생성 전 수정 업무거절 후 새 revision 복구, 잘못된 schema 분류 통과. | 외부 실제 채널의 운송 사건 계약은 별도. |
| T09 | 실제 HTTP fault proxy의429/503·Retry-After, WMS commit 후 응답 파괴, simulator SIGKILL 2회·같은 SQLite 재개, 동일키/본문·원접수 확인·차이0/미확인0 통과. 별도 partial 실행은60,197ms 클라이언트 오프라인 주입. | 별도 WMS SIGKILL/재시작·원사건 보존·효과1회 검증도 통과. **실제 네트워크 선로 차단은 별도 미실행.** |
| T10 | 전용 실제 API 실행에서 두 회사 동일 코드, 타회사/같은회사 다른창고 거절, 정식 관리자 로그인·일회키 발급/회수·다음401 통과. | 현장 계정·실키 정책 점검은 별도. |
| T11 | 인계·예약나이 monitor·shift.close API, 지속 journal 기반 T11 coordinator, 자동 worker 새 담당 적용 및 교대 단위 9개 검증. 별도 2회사 20초 HTTP smoke에서 예약보류·실제 교대·새 담당 작업 및 독립 대사 차이0 검증(v2-shift-smoke-latest.json) | **8시간·교대·10명 자동 작업자·장기 점유·혼잡 완주 미실행.** |
| T12 | 로컬 실제 HTTP에서 commit 응답 폐기→백업/복원→같은 세션/키·예약40·담당 보존→원요청 재조회/외부대기 사건 재개, 차이0·미확인0 통과. 별도18 migration/40 table synthetic 복원 통과. | **실제 제공자 복구·PITR/RPO/RTO와 운영 MVP 전환 리허설은 미실행.** |

`apps/simulator/runner.mjs`의 not_executed 목록은 이 제한을 공개한다. [100만 행 조회 시험 결과](v2-performance-latest.json)는 감사 시점 phase=measured, verdict=passed_local_million_ledger_read_profile로 상위 성능 담당자의 로컬 API/browser/DB 조회 측정 통과를 확인했다. 실제 8시간 쓰기·배포/단말 성능은 이 읽기 시험과 구분한다. [성능 실행계획](v2-성능시험-실행계획.md)의 8시간·5,400사건·누적 이력 동시 쓰기·실환경 목표를 부분 시나리오나 SQL 데이터 생성으로 완료 처리하지 않는다.

## 실제 운영 실행 보고서의 범위

- [추가 수락 시나리오 요약](v2-operational-acceptance-latest.json)은 최종 production build를 별도3023 runtime으로 실행한 T01/T02/T05/T06/T07/T08의 보고서 경로·해시·필수 하위 체크와 독립 대사를 고정한다. 전용 신규 품목/위치만 사용하며 원래100품목 catalog를 변경하지 않는다. 최초 harness 실패와 같은 SQLite 재개 이력은 요약의 한계에 남긴다.
- T03: `artifacts/v2-profile-shared/ea9a715f-6a0a-4bd9-8d94-0b02a7ff61c9.json`, T04: `ed5e2fc9-5f65-48ab-aa23-8c629c8052f0.json`, T10: `6357f571-1e03-44c6-8a0c-b2808eedac54.json`. 모두 `verdict=passed`, `not_executed=[]`이며 전용 시험 품목을 정식 API로 생성했다. 이 값은 해당 시나리오의 명시된 검사만 뜻한다.
- [T09](v2-t09-resilience-latest.json), 실행 `65cb92f5-a458-464d-9f9e-7bc5a139b759`: 실제 simulator 자식 프로세스의 SIGKILL 2회와 exit0 재개를 관측했다. 오류 프록시가429/503·응답유실을 만들었고 WMS 업무는 실제 HTTP로 확정했다. 별도 `artifacts/v2-simulator-tcp-partial.json`의60,197ms는 fetch를 막는 클라이언트 오프라인 주입이며 선로 장애 측정으로 바꾸어 부르지 않는다. damage/partial 실제 HTTP 시나리오의 대사는 각각 차이0이다.
- [짧은 혼잡](v2-congestion-smoke-latest.json)은 두 회사에서 각각20개 외부 사건과2작업자로 통과했다. [교대 smoke](v2-shift-smoke-latest.json)와 [runtime smoke](v2-shift-runtime-smoke-latest.json)는 실제 API 인계·담당 변경·마감·대사를 검증하지만 `eight_hour_requirement_passed=false`다. 지정25분/5,400사건과8시간/10명 완주의 대체 증거가 아니다.
- [복원 후 HTTP 재개](v2-recovery-replay-latest.json)는 당시17 migration/39 table 빌드의 로컬 클러스터 보고서다. [최신 synthetic 복원](restore-verification-latest.json)은18 migration/40 table과 외부 개시 이관 원본 해시를 포함한다. 둘 다 `provider_recovery=NOT_EXECUTED`를 유지한다.
- [100만 원장 조회](v2-performance-latest.json)는 고정된 production BUILD_ID의 로컬 조회 성능만 통과했다. 이후 승인분리·정정·보류/주소 경계 변경 소스를 포함한 재측정이나 장시간 쓰기 성능 통과를 주장하지 않는다. 이전 실패·진단 보고서는 보존하며 최신 통과 보고서로 실패 이력을 삭제하지 않는다.

- [AC13 WMS 실제 재시작](v2-wms-process-restart-latest.json)은 BUILD_ID `VuDcSWeSgbT_5k8fDYdmc`의 별도 로컬 서버에서 실제 SIGKILL과 새 PID 재시작을 확인했다. 처리 전 accepted 사건 보존, 같은 사건 재전송 및 예약 요청 재전송의 효과1회, 재고/전체 원장/예약 독립 대사 차이0이다. 제공자 복구·RPO/RTO를 대신하지 않는다.

## 최종 승인에 필요한 별도 증거

1. 최신 소스 전체 회귀와 신설 필수정보/스캔/담당자/정정/metrics 규칙의 API·UI·simulator 일치 확인.
2. T01~12와 13장 프로필의 실제 실행 보고서: 입력량/전달률, read/write 호출, 대사, 오류, p95, 미확인/격리·정리 결과.
3. G4: 실제 사람·PC·태블릿·스캐너 AC-15, 실제 제공자 복구 AC-16, 전환·교육·지원·경보 책임자 확인.
4. G5: 선정 현장 5영업일 병행 대조. 실물을 두 시스템에 중복 실행하지 않고 차이와 미해결 건을 기록.
