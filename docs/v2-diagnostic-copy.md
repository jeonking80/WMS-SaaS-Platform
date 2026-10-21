# 혼잡 실패 DB의 진단 복사

상태: **2026-10-20 23:28:35 UTC 두 사본 복사 및 검증 완료.** root의 명시적 지시와 원서버 종료(23:27:49.149973 UTC), 3021 listener 종료 확인 뒤 실행했다. source18은 변경 없이 보존했고 frozen18 parity 및 진단19 migration 후 parity가 모두 통과했다. 복제는 기존 성능 실패를 변경하지 않는다. 8시간 시험은 별도로 미실행 상태다.

## 경계

운영 wrapper `scripts/v2-diagnostic-copy.mjs`만 DB 연결을 다룬다. 시뮬레이터 앱에는 DB URL이나 관리자 권한을 제공하지 않는다. 원 DB 연결은 기존 비공개 `.env.local`의 `MIGRATION_DATABASE_URL`, `BOOTSTRAP_DATABASE_URL`, `DATABASE_URL` selector를 사용한다. 그 값이나 실제 DB pathname을 명령행·공개 로그·문서에 출력하지 않는다.

원본에는 DDL, 업무 DML, 마이그레이션, bootstrap 또는 role 변경을 하지 않는다. 공개 DB명과 다른 새 `wms_diagnostic_*` DB만 생성한다. 존재하는 DB에 restore, clean, drop, truncate를 수행하지 않는다. 중간 실패한 복제본도 자동 삭제하지 않고 실패 보고서와 함께 보존한다.

기존 두 실패 실행이 같은 원 DB에 남아 있으므로 특정 run의 행만 추출하거나 다른 실행을 제거하지 않는다. 원본 전체를 보존한다. 대상 실행 ID, 최종 실패 보고서 SHA, 원서버 종료 확인을 함께 인계한다. 현재 인계 대상은 `c83531b5-faad-4e95-836e-26c7056ed465`이며, 최초 실패 실행 `89990772-835e-4b2d-b9ee-4750ad668da0`도 그대로 남겨야 한다.

## 실행 전 필요한 인계

- 원 client의 최종 settle 및 보고서 생성 완료, 원 WMS 서버 종료.
- 최종 실패 보고서 경로와 SHA256. `verdict: failed` 및 run ID를 확인한다.
- source stopped 시각과 root의 실행 지시. 원 DB에 다른 연결이 남아 있으면 도구는 중지한다. 연결을 강제 종료하지 않는다.
- 원 마이그레이션 수, 검토된 새 마이그레이션 수. 현재 계획은 원 18개 → 복제본 19개이며 정식 `0018_v2-security-persistence`를 포함한다. 실제 수가 다르면 중지하고 계획을 재검토한다.
- 새 출력 디렉터리와 새 진단 DB명. 출력 디렉터리·DB가 이미 존재하면 재사용하지 않는다.

예시 설정에는 비밀값이 없다. 실제 원 DB명은 설정에도 필요하지 않다.

```json
{
  "source_run_id": "c83531b5-faad-4e95-836e-26c7056ed465",
  "source_migration_env": "MIGRATION_DATABASE_URL",
  "source_admin_env": "BOOTSTRAP_DATABASE_URL",
  "source_app_env": "DATABASE_URL",
  "frozen_database": "wms_diagnostic_frozen18_unique_suffix",
  "clone_database": "wms_diagnostic_c835_unique_suffix",
  "output_directory": "/tmp/wms-diagnostic-unique-suffix",
  "source_report_file": "/absolute/path/to/final-failed-report.json",
  "source_report_sha256": "REPLACE_WITH_FINAL_REPORT_SHA256",
  "source_stopped": false,
  "source_stopped_at": null,
  "expected_source_migration_count": 18,
  "apply_migrations": true,
  "expected_migration_count": 19
}
```

다음 기본 명령은 로컬 설정만 검사하며 DB 연결·Docker·복원·마이그레이션을 실행하지 않는다.

```sh
node scripts/v2-diagnostic-copy.mjs /tmp/reviewed-diagnostic-plan.json
```

원실행 종료와 root 지시를 받은 뒤에만 다음을 실행한다. 비밀값은 기존 환경 파일로만 읽는다.

```sh
node --env-file=.env.local scripts/v2-diagnostic-copy.mjs /tmp/reviewed-diagnostic-plan.json --execute
```

## 복사와 증명

1. 관리자 binding이 로컬 PostgreSQL과 Docker의 동일 cluster임을 기존 backup 도구로 확인한다. 세 source binding이 같은 DB를 가리키고 migration/app role이 맞는지 확인한다.
2. 원본에서 repeatable-read read-only 트랜잭션을 시작한다. 시간대·날짜·bytea 표현을 고정하고 public 업무 테이블의 행 수와 canonical row SHA256을 계산한다. 미검토 별도 application schema가 있으면 중지한다.
3. 같은 트랜잭션의 `pg_export_snapshot`을 `pg_dump --snapshot`에 전달한다. 행 hash와 archive가 같은 DB 경계다. archive는 새 파일에 mode 0600으로 스트리밍하며 SHA256을 남긴다.
4. 별도 관리자 연결로 새 DB를 만들고 PUBLIC connect를 회수한다. 소스 role 정의를 변경하지 않는다. `pg_restore --exit-on-error --single-transaction`으로 restore한다.
5. 새 DB의 모든 기존 table count/row hash, RLS flags, sequence, 창고 version, 원장 경계, 사건 status 집계가 원본과 정확히 같은지 비교한다. 같은 행 수만으로 동일성을 주장하지 않는다.
6. 이 비교가 통과한 경우에만 **복제본 URL**로 정식 migration runner를 호출한다. 19개 migration의 적용 상태를 확인한다. 원본 URL로 runner를 호출하는 경로는 없다.
7. 복제본의 기존 업무 데이터가 여전히 같은지 확인한다. 이번 migration에서 허용하는 데이터 차이는 `pgmigrations` 메타데이터/sequence와 새 빈 `rateLimit` 테이블뿐이다. 원래의 실패 사건·격리·예약·재고·원장·actor는 변경하지 않는다.
8. 모든 단계 후 원본을 새 read-only 경계에서 다시 fingerprint하여 최초와 같음을 증명한다. source의 새 migration 적용 여부는 항상 false다.

행 hash는 `SHA256(UTF8(to_jsonb(row)::text))`이며, 정렬한 행 hash를 LF로 연결한 전체 SHA256과 행 수를 보존한다. 동일 내용의 중복 행도 개수와 hash 목록의 중복 횟수에 포함된다. SQL row 순서에 의존하지 않는다. 원장과 창고 version, 사건의 격리·대기 상태 집계도 따로 보존한다. 이는 업무 행 동일성 증명이며 실제 호스팅 복구의 RPO/RTO 인증이 아니다.

새 출력 디렉터리에는 `source.dump`, `report.json`, `clone-bindings.env`가 생긴다. 디렉터리는 mode 0700, 파일은 mode 0600이다. dump와 bindings는 비공개 자료다. report에는 source/clone DB명의 해시만 쓰고 연결 URL·암호·사건 payload는 쓰지 않는다. 복제본 API 서버를 띄우거나 자동 재처리하는 동작은 이 도구에 없다.

## 검증과 후속 작업

준비된 독립 회귀는 `scripts/test/v2-diagnostic-copy.test.mjs`다. selector·대상명 검증, 같은 행 수의 다른 hash, RLS/원장/상태/sequence 차이, 새 migration의 제한된 차이 허용을 검사한다. root 승인 후 독립 회귀 3개가 모두 통과했다.

원실행 종료 뒤 root가 허용하면 독립 회귀를 실행하고, 실제 source copy/restore/hash/migration 검증을 수행한다. 문서 준비나 plan-only 출력은 복사 성공이 아니다. 성공 보고서의 `copied_and_verified`, source unchanged, restore 비교, migration 후 비교가 모두 있어야 실제 사본 확보로 기록한다.

추가 계측과 성능 개선 실험은 검증된 복제본에서만 수행한다. 실패 원본과 원 보고서는 수정하지 않는다. 새 진단 실행의 결과를 원 혼잡 실행의 합격으로 바꾸지 않는다.

## 두 사본 보존 절차

현재 작업에는 `frozen_database`와 `clone_database`를 모두 지정한다. 같은 단일 source snapshot dump를 두 새 DB에 각각 restore한다. frozen 사본은 원본 18개 migration과 모든 fingerprint의 parity를 확인한 뒤 `ALLOW_CONNECTIONS false`로 연결을 막고, migration/app role의 CONNECT 권한도 회수한다. 관리자가 이 잠금을 명시적으로 풀기 전까지 진단 실행에는 사용하지 않는다. dump는 SHA256을 기록하고 mode 0400으로 잠근다. OS 관리자 권한에 대한 WORM 보증은 아니다.

그 뒤 별도 clone에만 migration 19를 적용한다. `report.json`의 `frozen_copy_comparison.passed`, `frozen_connections_disabled`, `copy_comparison.passed`, `post_migration_content_comparison.passed`, `source_unchanged.passed`가 모두 true이고 status가 `copied_and_verified`여야 기본 개발 DB를 후속 작업에 재사용할 수 있다. frozen 사본과 archive 및 원 실행 보고서는 그대로 보존한다. frozen DB 연결 URL은 생성하지 않는다.

실행 증거: `/tmp/wms-diagnostic-c835-20261020-two-copy/report.json` (`copied_and_verified`). source before/after 18개 migration, frozen 18개, diagnostic 19개다. 모든 비교는 `passed: true`, `differences: []`다. frozen DB 연결은 비활성화했다. dump는 16,465,896 bytes, mode 0400, SHA256 `40cc61a425e306991400d39a8bde88b5f7506415decb8284d279fa40b2f3c78a`다. 원 실패 보고서 SHA256은 `931372e6e9fd3146f1fcee477a841d6ae9defcc16f896d585772444a537410de`다. 원본에 migration을 적용하지 않았다. source 보존 및 두 사본 검증 완료를 root에 인계하여 기본 개발 DB의 후속 작업 재사용이 가능함을 알렸다.
