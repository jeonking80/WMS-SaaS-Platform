# WMS Lite DB 설계

## 구현 범위

PostgreSQL 17, `pg` SQL 접근, `node-pg-migrate` SQL 마이그레이션을 사용한다. 6단계까지 입고·출고·이동·확정 취소와 조회·대시보드·최소재고를 구현했다. 출고 배송정보 보완을 포함한 마이그레이션은 총 8개다.

| 테이블 | 컬럼 | 제약·기본값 |
|---|---|---|
| `tenants` | `id` | UUID PK, `gen_random_uuid()` |
| | `name` | varchar(128), NOT NULL, 공백만 있는 이름 금지 |
| | `active` | boolean, NOT NULL, 기본 true |
| | `created_at` | timestamptz, NOT NULL, 현재 시각 |
| `pgmigrations` | 도구 관리 이력 | 적용한 버전 기록, 동일 버전 재적용 방지 |
| `user`, `session`, `account`, `verification` | Better Auth 기본 스키마 | 계정·비밀번호 해시·세션·검증 데이터, 라이브러리 관례의 camelCase 컬럼 |
| `memberships` | user_id, tenant_id, role | 사용자당 소속 하나, 역할은 admin/worker/viewer, 실제 사용자·회사 FK |
| `items` | id, tenant_id, code, name, active, created_at | 회사별 코드 고유, (tenant_id,id) 복합 고유키, 이름·코드 공백 금지, FORCE RLS |

회사명은 고유 식별자로 사용하지 않는다. 모든 참조는 UUID를 사용한다. 시각은 `timestamptz`로 저장하고 사용자 표시는 `Asia/Seoul` 기준으로 처리한다.

## 로컬 DB와 명령

`.env.local`에 `POSTGRES_PASSWORD`를 설정한다. 비밀값은 저장소에 커밋하지 않는다. URL 비밀번호의 특수문자는 URL 인코딩한다. 예시 파일의 빈 변수에는 실제 로컬 접속정보를 채워야 한다.

```sh
docker compose --env-file .env.local --profile test up -d --wait
npm run db:setup
npm run db:check
npm run test:integration
```

- 개발 DB: `wms_lite`, 기본 포트 5432, 영속 볼륨.
- 테스트 DB: `wms_lite_test`, 기본 포트 5433, `test` 프로필과 임시 메모리 볼륨. 컨테이너를 재생성하면 테스트 데이터가 초기화된다.
- 두 포트는 localhost에만 노출한다. 다른 프로젝트의 DB와 연결하지 않는다.
- `BOOTSTRAP_DATABASE_URL`: 로컬 관리자 연결. 역할 생성·소유권·권한 준비에만 사용한다.
- `MIGRATION_DATABASE_URL`: `wms_migrator` 연결. 마이그레이션·개발 시드를 실행하며 스키마·테이블을 소유한다.
- `DATABASE_URL`: `wms_app` 연결. 일반 앱 요청을 처리한다. 관리자 계정 URL을 지정하면 앱 설정 검사가 거절한다.
- `TEST_DATABASE_URL`: 통합 테스트 전용. DB명이 `_test`로 끝나야 실행된다.
- `POSTGRES_PASSWORD`: Compose 초기 DB 암호. 이미 초기화된 개발 볼륨에서는 이 변수를 바꿔도 기존 역할의 암호가 바뀌지 않는다.

마이그레이션은 한 트랜잭션에서 실행되고 도구의 잠금 기능을 유지한다. `npm run db:migrate`는 순방향 적용만 제공한다. 이미 적용한 파일을 수정하지 말고 새 버전의 파일을 추가한다. Down SQL은 별도 복구 검토를 위한 것이며 기본 실행 흐름에 포함하지 않는다.

`db:setup`은 `db:bootstrap → db:migrate → db:bootstrap -- --grant → db:seed → auth:seed` 순서다. 실행 중 앱 권한을 재설정하므로 서버를 시작하기 전에 실행한다. 반복해도 기존 데이터와 계정 비밀번호·소속·역할을 덮어쓰지 않는다.

`db:seed`는 합성 회사 A/B, `auth:seed`는 회사별 관리자·작업자·조회자 계정을 만든다. 비밀번호는 `DEMO_PASSWORD`에서 읽고 Better Auth의 공식 `hashPassword`로 처리한다. 앱에 관리자 계정 생성 플러그인이나 공개 회원가입은 노출하지 않는다. 기존 계정의 소속과 시드 기대값이 다르면 자동 재배정하지 않고 중단한다. production 모드의 개발 시드 실행은 거절한다. 실제 초기 재고는 후속 입고 확정 서비스로 생성한다.

## 통합 검증

실제 PostgreSQL 테스트 DB에 임의 이름의 전용 스키마를 만들고 아래를 확인한 후 해당 스키마만 삭제한다. 테스트 DB나 public 스키마를 초기화하지 않는다.

1. 빈 스키마에 회사·인증·업무 격리·초안·확정·취소·대시보드·배송정보 마이그레이션 8개가 실행된다.
2. 회사 삽입 시 UUID·활성값·생성 시각이 생성된다.
3. 다시 마이그레이션하면 적용 건수는 0이며 기존 데이터와 이력이 유지된다.
4. 공백뿐인 회사명·NULL 회사명은 DB 제약으로 거절된다.

환경변수가 없거나 실제 DB에 접속할 수 없으면 검증을 건너뛰지 않고 실패한다. RLS 테스트는 별도의 제한된 LOGIN 역할을 만들고 실제 `withTenant` 헬퍼와 최대 연결 수 1인 풀을 사용한다. 테스트가 만든 역할과 스키마만 종료 시 삭제한다.

## 1단계 권한과 회사 격리

Compose의 `postgres`는 초기화용 관리자다. `wms_migrator`는 테이블 소유자이고 `wms_app`은 소유자가 아닌 `NOSUPERUSER`, `NOBYPASSRLS` 역할이다. bootstrap은 앱 역할의 다른 역할 상속을 제거하고 public 스키마 CREATE와 불필요한 테이블 권한을 거둔다. `db:check`는 실제 앱 계정의 관리자·RLS 우회·테이블 소유 여부를 검사한다.

- 앱에 인증 테이블 SELECT/INSERT/UPDATE/DELETE, 회사·소속 SELECT, items SELECT/INSERT/UPDATE/DELETE만 부여한다. 마이그레이션 이력 쓰기, DDL, TRUNCATE는 허용하지 않는다.
- 인증 세션에서 사용자 ID를 얻고, 신뢰된 소속 조회가 사용자 ID를 기준으로 활성 회사와 역할을 결정한다. 회사·인증 등록부는 회사 컨텍스트 이전의 내부 인증 경로이며 공개 목록 API가 없다.
- `items`의 읽기·변경·삽입은 `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` 정책으로 제한한다. 컨텍스트가 없으면 읽을 행이 없고 삽입은 거절된다. FORCE RLS로 테이블 소유자도 정책 대상이다.
- `withTenant`는 하나의 연결에서 BEGIN, 트랜잭션 범위 `set_config`, 업무 쿼리, COMMIT을 수행한다. 오류 시 ROLLBACK하고 연결을 반환하며, 롤백에 실패한 연결은 폐기한다.
- 회사 ID는 API에서 인증된 소속을 전달한다. 쿼리 매개변수·요청 본문·헤더에서 회사나 역할을 채택하지 않는다.
- A/B 교차 요청, 회사 컨텍스트 누락, 같은 물리 연결의 커밋·롤백 후 재사용, 권한 상승·DDL·TRUNCATE 거절을 실제 제한 계정으로 검증했다.

기준정보·전표·현재고·원장·감사·중복 방지 테이블 모두 회사 RLS를 적용하고 검증한다. 원장·감사·중복 방지 기록의 앱 권한은 SELECT/INSERT만 허용한다.


## 2단계 스키마와 잠금

마이그레이션 `1792368000003_p2-drafts.sql`에 창고·위치·전표·명세를 추가한다. 모든 업무 테이블에 ENABLE/FORCE RLS와 회사 컨텍스트의 USING/WITH CHECK 정책을 적용한다. 앱에는 이 테이블의 SELECT/INSERT/UPDATE/DELETE만 허용하고 DDL/TRUNCATE는 허용하지 않는다.

| 테이블 | 핵심 제약 |
|---|---|
| warehouses | 회사+코드 및 회사+ID 고유 |
| locations | 회사+창고+코드 고유, 회사 포함 창고 FK, 회사+창고+ID 고유 |
| inventory_documents | 회사 포함 창고·출발위치·도착위치 FK, 위치와 창고 일치, 유형별 NULL/상이 위치 검사, 상태 DRAFT/CANCELLED, 양의 version |
| inventory_document_lines | 회사 포함 전표·품목 FK, 회사+전표+품목 고유, 정수 수량 1~1,000,000,000, 전표 삭제 시 명세 CASCADE |

전표 생성·수정은 창고→UUID순 위치→UUID순 품목에 FOR SHARE 잠금을 잡아 활성 참조를 검사한다. 수정·취소는 먼저 전표 FOR UPDATE 잠금과 버전을 검사한다. 상세 조회는 전표 FOR SHARE 후 명세를 읽어 일관성을 유지한다. 기준정보 변경은 대상 FOR UPDATE 후 미취소 초안 참조를 검사한다. 위치 변경은 부모 창고를 먼저 잠근다. 모두 withTenant 트랜잭션 안에서 실행하므로 동시 비활성화와 초안 저장을 직렬화한다.

품목 1~20개와 메모 길이는 서비스 입력에서 검사한다. 비활성화 시 초안 참조 및 창고의 활성 하위 위치를 차단한다. 취소된 전표가 참조하는 기준정보는 비활성화해도 이력을 조회할 수 있다. 3단계에서는 잔량이 있는 품목·위치·창고의 비활성화도 차단한다.


## 3단계 입고·재고 스키마

`1792368000004_p3-posting.sql`은 전표 POSTED 상태·posted_at과 아래 테이블을 추가한다. 새 업무 테이블 모두 회사 RLS를 강제한다.

| 테이블 | 제약·앱 권한 |
|---|---|
| stock_balances | 회사·위치·품목 PK, 회사 포함 위치/창고·품목 FK, bigint 수량 0~9,007,199,254,740,991. SELECT/INSERT/UPDATE만 허용 |
| stock_ledger | 회사·전표·위치·품목 고유, 회사 포함 FK, 증감 수량 0 금지. SELECT/INSERT만 허용 |
| idempotency_requests | 회사·키 PK, 요청 해시·성공 응답 JSONB 필수. SELECT/INSERT만 허용 |
| audit_logs | 회사 포함 전표 FK, 사용자 FK, 처리 동작·시각. SELECT/INSERT만 허용 |

입고는 전표 FOR UPDATE → 회사/키 트랜잭션 advisory lock → 활성 창고/위치/UUID순 품목 FOR SHARE → UUID순 잔량 INSERT ON CONFLICT DO NOTHING 및 FOR UPDATE 순서로 잠근다. 없는 잔량 행도 동일 경로로 생성해 최초 입고 경쟁을 직렬화한다. 원장·현재고·상태·감사·요청 결과를 모두 같은 withTenant 트랜잭션에 기록한다.

키는 회사 범위다. SHA-256 해시는 POST_INBOUND·전표ID·요청 버전으로 구성한다. 저장된 응답은 상태·버전 재검사보다 먼저 읽되, 현재 요청의 인증·역할·회사·전표 접근 검사는 먼저 수행한다. 성공 응답 보존 기간/정리 작업은 아직 제공하지 않는다.

기준정보 비활성화는 같은 행 잠금 뒤 현재고 양수 여부도 검사한다. 입고 참조 잠금과 직렬화되므로 입고 완료 직후 남은 재고를 놓치지 않는다. 대조 기능은 단일 SQL의 FULL JOIN으로 원장 합계와 잔량을 비교한다. 원장 수정·삭제와 자동 잔량 보정은 제공하지 않는다.


## 4단계 출고 트랜잭션

3단계 스키마를 재사용하며 새 마이그레이션은 필요하지 않다. 공통 postDocument 서비스는 잠근 전표의 유형으로 POST_INBOUND/POST_OUTBOUND 작업을 결정한다. 기존 입고 성공 요청의 해시는 그대로 유지한다.

출고도 전표 → 회사/키 advisory lock → 창고 → 출발 위치 → 품목 ID순 참조 → 품목 ID순 잔량을 잠근다. 모든 잔량을 확보한 후 모든 수량을 검사하고 나서 차감·음수 원장·상태·감사·응답 기록을 저장한다. 없는 잔량은 부족으로 처리하며 0 잔량 행을 생성하지 않는다. 입고는 종전처럼 없는 잔량 행을 확보한다.

확정 트랜잭션에만 SET LOCAL lock_timeout='1000ms'를 적용한다. 실패 시 withTenant가 전체 롤백하며 연결 재사용 후 설정이 남지 않는다. 잠금 실패는 재시도 가능 오류로 반환한다. 음수 재고 방지는 잠긴 잔량 검사와 DB CHECK를 함께 사용한다.


## 5단계 반대 전표와 공통 잠금

`1792368000005_p5-reversals.sql`에서 전표 REVERSED 상태, reversal_of_id, reversed_at을 추가한다. `(tenant_id,reversal_of_id)` 고유 제약은 원본당 하나의 반대 전표를 보장한다. 회사 포함 자기 참조 FK는 타 회사 원본 연결을 거절한다. 반대 전표는 자신을 참조할 수 없고 POSTED 상태만 허용한다.

확정·취소 모두 전표 → 회사/키 advisory lock → 창고 → 위치 UUID순 → 품목 UUID순 → (위치 UUID, 품목 UUID)순 잔량 잠금을 사용한다. 증가할 잔량의 최초 행 확보도 이 순서 안에서 수행한다. 모든 잔량을 잠그고 수량을 검사한 뒤 원장과 잔량을 반영한다. 반대 방향 이동에서도 같은 잠금 순서를 사용한다.

취소 수량은 원본 원장으로부터 결정한다. 유형별 위치·부호·수량·이동 양쪽 수량 일치를 검사하고 반대 부호의 효과를 생성한다. 원본 명세·원장·posted_at은 변경하지 않는다. 반대 전표와 양수 명세, 반대 원장, 원본 REVERSED 상태·reversed_at·버전, 감사 및 요청 응답을 한 트랜잭션으로 저장한다.

과거 확정 취소는 비활성 기준정보도 참조하되 같은 FOR SHARE 잠금을 사용한다. 원장을 수정하거나 재고를 직접 덮어쓰는 복구 경로는 만들지 않는다. 잠금 대기 1초와 전체 롤백·멱등 재시도 규칙을 유지한다.


## 6단계 최소재고·조회 인덱스와 집계

`1792368000006_p6-dashboard.sql`은 일곱 번째 마이그레이션이다. items.min_stock은 bigint NOT NULL DEFAULT 0이며 CHECK로 0~1,000,000,000을 제한한다. API는 JSON 숫자 정수로 입력받고 조회 시 문자열로 반환한다. 관리자의 품목 POST/PATCH에만 이 필드를 허용한다.

| 인덱스 대상 | 컬럼 순서 | 목적 |
|---|---|---|
| inventory_documents | tenant_id, created_at DESC, id DESC | 회사별 전표 페이지 |
| inventory_documents | tenant_id, posted_at DESC | 확정일 범위·일별 실적 |
| inventory_documents | tenant_id, reversed_at DESC, WHERE reversed_at IS NOT NULL | 취소일 범위·일별 취소 |
| stock_ledger | tenant_id, created_at DESC, id DESC | 회사별 최신 원장 |
| stock_balances | tenant_id, item_id | 회사 전체 위치의 품목별 합계 |
| audit_logs | tenant_id, created_at DESC, id DESC | 회사별 감사 페이지 |
| inventory_document_lines | tenant_id, item_id, document_id | 품목 조건에 해당하는 전표 검색 |

기존 PK·회사별 고유 제약 인덱스와 같은 컬럼 순서를 중복 생성하지 않는다. 목록은 기본 25개·최대 100개이며 전체 건수와 페이지를 같은 SQL 문장에서 계산한다. 코드·이름 부분 검색과 깊은 OFFSET의 비용까지 모든 조건을 인덱스가 해결한다고 가정하지 않는다. 실제 계획·데이터량·소요 시간은 별도 `npm run test:performance`와 [6단계 성능 측정](6단계-성능측정.md)에 기록한다.

대시보드는 withTenant 내부의 단일 SQL 문장으로 집계하므로 모든 구성 요소가 동일한 MVCC 스냅샷을 사용한다. UTC timestamptz를 Asia/Seoul 날짜 경계로 비교하고 서버 시각으로 오늘 포함 7일을 생성한다. 원본 posted_at은 REVERSED 이후에도 실적에 남기고 reversed_at을 취소 실적으로 별도 계산한다. reversal_of_id가 있는 반대 전표는 입출고 실적에서 제외한다.

재고 보유 품목은 활성 여부와 무관한 회사 전체 양수 합계, 부족 재고는 활성 품목 LEFT JOIN 품목별 잔량 합계에 COALESCE(0)를 적용한 최소재고 미달이다. recent는 모든 역할에서 POSTED/REVERSED만 반환한다. 기준정보 선택용 `/api/lookups`는 회사별 창고·위치를 각 최대 1,000개 반환한다. RLS·회사 포함 FK·변경 트랜잭션 권한은 기존 경계를 유지한다. 검증 근거는 [6단계 검증 결과](6단계-검증결과.md)에 기록한다.


## 출고 배송정보 추가

여덟 번째 `1792368000007_outbound-delivery.sql`은 inventory_documents에 nullable recipient_name varchar(128), delivery_address varchar(500)를 추가한다. 기존 전표의 값은 null로 유지한다. 두 값이 모두 null이거나 OUTBOUND에서 두 값이 모두 채워진 경우만 DB 제약이 허용하며 저장값은 앞뒤 공백이 없어야 한다. 새 출고의 필수 입력은 서버 서비스와 확정 처리에서도 검사한다. 반대 전표와 기존 기록은 null을 허용한다.

기존 Neon 데모에는 [추가 전용 SQL](../deploy/neon-outbound-delivery.sql)을 사용한다. 초기화 SQL 또는 데모 시드를 다시 실행하지 않는다. 추가 SQL은 기존 계정·전표·재고를 수정하지 않고 스키마와 마이그레이션 이력만 갱신하며 재실행 시 중복 적용하지 않는다. 실제 외부 적용 결과 확인 전에는 새 코드를 공개 앱에 적용하지 않는다.
