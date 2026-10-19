# WMS Lite API 명세

**상태:** 3단계 입고 확정·현재고·원장·대조 기능까지 구현했다. 출고·이동 확정과 확정 취소는 이후 단계다.

## 1. 구현된 API

### `GET /api/health` — 애플리케이션 생존 확인

인증 없이 호출한다. Next.js 요청 처리 가능 여부만 확인하며, DB 연결이나 업무 기능 준비 완료를 의미하지 않는다.

- 성공: HTTP `200`, `Content-Type: application/json`, `Cache-Control: no-store`
- 응답: `{ "status": "ok" }`
- 입력: 없음

### `GET /api/ready` — 데이터베이스 연결 확인

인증 없이 호출한다. 서버의 `DATABASE_URL`로 PostgreSQL에 연결하여 `tenants` 테이블의 조회 가능 여부를 확인한다. 따라서 DB 연결뿐 아니라 최초 마이그레이션 적용도 필요하다. 회사 데이터는 응답에 포함하지 않는다. 연결 문자열, 호스트, DB 오류 상세를 응답에 노출하지 않는다. 전체 스키마·인증·RLS·업무 데이터 정합성 검사를 대신하지 않는다.

| 결과 | HTTP 상태 | JSON 응답 |
|---|---|---|
| 연결 및 쿼리 성공 | `200` | `{ "status": "ok", "database": "ok" }` |
| 설정 누락 또는 DB 연결·쿼리 실패 | `503` | `{ "status": "unavailable", "database": "unavailable" }` |

모든 응답에 `Cache-Control: no-store`를 설정한다. 입력은 없다. 마이그레이션이나 데이터 변경을 수행하지 않는다.

### 인증·사용자·기준정보 조회

| API | 동작·접근 조건 |
|---|---|
| `POST /api/auth/sign-in/email` | 이메일·비밀번호로 로그인, Better Auth 세션 쿠키 발급 |
| `POST /api/auth/sign-out` | 세션 폐기, 정상 origin 필요 |
| `GET /api/auth/get-session` | 라이브러리의 세션 조회, 만료·폐기된 세션은 유효 사용자로 인정하지 않음 |
| `GET /api/me` | 로그인한 사용자와 활성 소속·역할 반환. 미인증 401, 소속이 없거나 비활성 회사 403 |
| `GET /api/items` | 관리자·작업자의 자사 품목 조회. code/id 순서 최대 1,000개. 조회자는 403 |
| `GET /api/items/{id}` | 관리자·작업자의 자사 품목 상세. 없거나 타 회사 대상 또는 잘못된 UUID는 404 |

`/api/me` 응답은 `{ user: { id, name, email }, tenant: { id, name }, role }`이며 role은 admin/worker/viewer다. 품목 응답은 `{ items: [...] }`, `{ item: {...} }`이고 각 항목은 id/code/name/active만 포함한다. 요청의 `tenant_id`나 역할 헤더는 권한 판단에 사용하지 않는다. 회사·역할은 매 요청 세션과 DB 소속으로 확인한다.

사용자·품목 API는 `Cache-Control: no-store`를 반환한다. 오류 형식은 `{ error: code }`이고 `UNAUTHENTICATED`(401), `MEMBERSHIP_REQUIRED`·`ROLE_FORBIDDEN`(403), `NOT_FOUND`(404), 내부 오류 상세를 감춘 `SERVICE_UNAVAILABLE`(503)을 사용한다.

회원가입은 비활성화한다. 인증 요청은 Better Auth의 출처·요청 제한 규칙을 유지하며 신뢰하지 않는 origin은 403, 요청 제한에 도달하면 429를 반환한다. 라이브러리 인증 경로의 오류 본문은 자체 형식을 따른다. 앱의 관리자 사용자 생성 API는 제공하지 않는다.

## 2. 단계별 업무 API

1~3단계 경로는 구현했다. 입고 확정만 지원하며 4단계 이후 출고·이동·확정 취소는 예정 경로다.

| 단계 | API | 목적 |
|---|---|---|
| 1 | `/api/me`, 인증 라이브러리 경로 | 세션·사용자 소속·역할, 로그인·로그아웃 |
| 2 | `/api/items`, `/api/warehouses`, `/api/locations` | 기준정보 관리 |
| 2 | `/api/documents`, `/{id}`, `/{id}/cancel` | 전표 초안 작성·수정·조회·취소 |
| 3~4 | `/api/documents/{id}/post` | 입고·출고 확정 |
| 3~6 | `/api/stock`, `/api/stock-ledger` | 현재고 및 원장 조회 |
| 5 | `/api/documents/{id}/reverse` | 관리자 확정 취소 |
| 6 | `/api/dashboard`, `/api/audit-logs` | 집계 및 작업 이력 |

## 3. 업무 API 공통 설계 기준

- 회사는 인증된 사용자 소속으로 결정하며 클라이언트의 회사 ID를 신뢰하지 않는다.
- 미인증 요청은 `401`, 허용 역할 부족은 `403`, 타 회사의 개별 대상 접근은 `404`로 처리한다.
- 인증 라이브러리의 세션·쿠키·변경 요청 보호 기능을 사용한다. 공개 회원가입·초대는 제공하지 않는다.
- 회사 업무 응답은 공용 캐시에 저장하지 않는다.
- 전표 수정·확정 시 버전을 검사하고 오래된 버전의 변경은 충돌로 거절한다.
- 확정 요청에는 `Idempotency-Key`를 사용한다. 재반환 전에도 현재 인증·역할·회사·대상 권한을 검사한다. 같은 키·다른 입력은 충돌로 처리한다.
- 요청 ID, 입력 검증 오류, 재고 부족·버전 충돌·재시도 가능 오류의 정확한 응답 형식은 해당 단계에서 문서와 테스트로 고정한다.

## 4. 현재 검증 범위

Playwright는 초기 화면·상태 API, 보호 화면의 로그인 필요 여부, 역할별 로그인·로그아웃, A→B 세션 전환, 가입·외부 origin 차단, 세션 만료, 역할 변경 즉시 반영, 회사 위조 요청과 품목 상세 404, 조회자 403을 검사한다. 실제 PostgreSQL에서는 비소유자·비관리자 역할로 RLS와 연결 재사용을 별도 검증한다. 전표 초안의 입력·참조·역할·회사 격리·동시 수정·취소와 브라우저 작성 흐름을 검증한다. 3단계에서는 입고 확정·중복·동시 요청·롤백·응답 유실 복구와 재고 대조를 추가 검증했다.


## 5. 2단계 기준정보 계약

`items`, `warehouses`, `locations` 모두 `GET /api/{종류}`, `POST /api/{종류}`, `GET /api/{종류}/{id}`, `PATCH /api/{종류}/{id}`를 제공한다. 조회는 관리자·작업자, 생성·변경은 관리자만 허용한다. 삭제 경로는 제공하지 않는다.

- 목록은 `{ items: [...] }`처럼 복수형, 상세·변경은 `{ item: {...} }`처럼 단수형이다. 생성은 201, 나머지 성공은 200이다.
- 생성 입력은 `{ code, name }`, 위치는 `warehouse_id`도 필요하다. 활성 상태는 true로 생성한다.
- PATCH는 `code`, `name`, `active` 중 하나 이상을 받는다. 위치의 소속 창고는 변경할 수 없다. 알려지지 않은 필드는 거절한다.
- 코드는 앞뒤 공백 제거·대문자 변환 후 1~64자, 이름은 앞뒤 공백 제거 후 1~128자다.
- 응답은 id/code/name/active, 위치는 warehouse_id도 포함한다. 목록은 코드순 최대 1,000개이며 위치 목록에 `?warehouse_id=UUID` 필터를 지원한다.
- 회사 내 품목·창고 코드와 회사·창고 내 위치 코드가 고유하다. 초안이 참조하는 기준정보는 비활성화할 수 없다. 활성 위치가 있는 창고도 비활성화할 수 없다. 비활성 창고에 위치를 생성·재활성화할 수 없다.

## 6. 2단계 전표 계약

관리자·작업자만 모든 전표 API를 이용한다. 조회자는 목록·상세·변경 모두 403이다.

| 경로 | 입력 | 성공 응답 |
|---|---|---|
| `GET /api/documents` | 없음 | 200 `{ documents: [...] }`, 최신 변경순 최대 100개, 명세 제외 |
| `GET /api/documents/{id}` | 없음 | 200 `{ document: {..., lines: [...] } }` |
| `POST /api/documents` | 아래 전체 초안 | 201 `{ document: {..., lines: [...] } }` |
| `PATCH /api/documents/{id}` | 전체 초안 + 현재 `version` | 200 갱신된 document |
| `POST /api/documents/{id}/cancel` | `{ version }` | 200 취소된 document |

```json
{
  "kind": "INBOUND",
  "warehouse_id": "UUID",
  "destination_location_id": "UUID",
  "note": "입고 초안",
  "lines": [{ "item_id": "UUID", "quantity": 10 }]
}
```

입고는 도착 위치만, 출고는 출발 위치(`source_location_id`)만, 이동은 서로 다른 출발·도착 위치를 지정한다. 모든 위치는 선택한 창고에 속해야 한다. 품목은 중복 없이 1~20개이며 수량은 1~1,000,000,000 정수다. 메모는 최대 2,000자다. 생성·수정 시 모든 참조는 활성 상태여야 한다. 다른 회사·존재하지 않는·비활성 참조는 404 `REFERENCE_NOT_FOUND`로 처리한다.

전표는 DRAFT/version=1로 생성된다. 수정·취소 시 행 잠금 후 버전을 비교하고 성공하면 1 증가한다. 오래된 버전은 409 `VERSION_CONFLICT`, 취소 전표 변경은 409 `INVALID_STATE`다. 취소는 DRAFT→CANCELLED이며 명세를 유지한다. 상세 헤더와 명세는 같은 잠금 범위에서 읽는다. 초안 작업은 재고·원장을 생성하거나 변경하지 않는다.

업무 변경 요청은 `Content-Type: application/json`과 `BETTER_AUTH_URL`의 origin과 일치하는 `Origin` 헤더가 필요하다. 출처 불일치는 403 `ORIGIN_FORBIDDEN`, 잘못된 JSON/입력은 400 `INVALID_INPUT`, 코드 중복은 409 `CONFLICT`, 사용 중 비활성화는 409 `IN_USE`, 비활성 부모 창고는 409 `INACTIVE_REFERENCE`다. 인증된 회사만 사용하며 전표 본문에 넣은 `tenant_id`는 무시한다. 모든 업무 응답은 no-store다.

목록 페이지네이션·검색은 현재 제공하지 않으며 위 개수 제한을 적용한다.


## 7. 3단계 입고 확정·재고 조회

### `POST /api/documents/{id}/post`

관리자·작업자만 호출한다. JSON 본문 `{ "version": 1 }`, 정상 Origin, `Idempotency-Key` 헤더가 필수다. 키는 영문·숫자·마침표·밑줄·콜론·하이픈 1~128자다. 현재는 INBOUND/DRAFT만 처리한다. 출고·이동은 409 INVALID_STATE다.

성공 200 응답은 `{ document: { id, status: "POSTED", version, posted_at }, ledger_entries }`다. 전표 버전은 1 증가하고 품목별 입고 수량만큼 현재고와 원장을 반영한다. 감사 기록에 처리자·전표·시각·POST_INBOUND 동작을 기록한다.

- 같은 회사·같은 키·같은 전표와 요청 버전은 저장한 성공 응답을 다시 반환한다. 재시도는 최초 요청의 버전과 키를 유지한다.
- 같은 키·다른 전표 또는 버전은 409 IDEMPOTENCY_CONFLICT다. 다른 키로 확정된 전표를 다시 처리하면 409 INVALID_STATE이며 추가 반영이 없다.
- 재반환 전에도 현재 세션·회사·역할과 전표 접근을 확인한다. 타 회사 전표는 404다.
- 잠금 시간 초과·교착·직렬화 실패는 503 RETRYABLE_TRANSACTION이다. 통신 장애나 서버 오류 후에는 같은 키·버전으로 재시도한다. 오류 상세는 노출하지 않는다.
- 현재고 누적 상한 9,007,199,254,740,991 초과는 409 STOCK_OVERFLOW다. 전표별 수량 상한은 기존 1,000,000,000을 유지한다.
- 재고·원장·전표 상태·감사 기록·성공 응답은 한 트랜잭션으로 커밋한다. 중간 실패는 모두 롤백한다. 확정 후 PATCH와 초안 cancel은 허용하지 않는다.

### 조회 API

아래 경로는 관리자·작업자·조회자 모두 자신의 회사 범위에서 조회한다. JSON 수량은 bigint 정밀도를 보존하는 문자열이다. 모든 응답은 no-store다.

| 경로 | 응답 |
|---|---|
| `GET /api/stock` | `{ stock: [{ warehouse_id, warehouse_name, location_id, location_code, item_id, item_code, item_name, quantity }] }` |
| `GET /api/stock-ledger` | `{ entries: [{ id, document_id, warehouse_name, location_code, item_code, item_name, quantity_delta, created_at }] }` |
| `GET /api/stock/reconcile` | `{ consistent, mismatches: [{ location_id, item_id, balance_quantity, ledger_quantity }] }` |

현재고와 원장 목록은 각각 최대 1,000개이며 원장은 최신순이다. 대조는 목록 제한과 무관하게 회사 전체를 단일 SQL 스냅샷으로 비교하며 누락된 잔량·원장도 포함한다. 불일치를 보고할 뿐 자동 보정하지 않는다. 조회자에게 전표 초안 API는 계속 차단한다. 감사 기록 조회 화면/API는 6단계 범위다.

화면은 저장된 입고 초안만 확정한다. 미저장 변경이 있으면 먼저 저장해야 한다. 결과를 받지 못한 요청의 키·버전을 sessionStorage에 보관하고 같은 요청 재시도와 상태 새로고침을 제공한다. 재고가 있는 품목·위치·창고는 비활성화할 수 없다.
