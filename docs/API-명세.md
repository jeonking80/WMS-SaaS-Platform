# WMS Lite API 명세

**상태:** 6단계 검색·필터·페이지 처리, 역할별 확정 이력, 대시보드·감사 조회와 최소재고 설정을 구현했다.

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

`/api/me` 응답은 `{ user: { id, name, email }, tenant: { id, name }, role }`이며 role은 admin/worker/viewer다. 품목 응답은 `{ items: [...] }`, `{ item: {...} }`이고 각 항목은 id/code/name/active/min_stock을 포함한다. min_stock은 정밀도를 보존하는 문자열이다. 요청의 `tenant_id`나 역할 헤더는 권한 판단에 사용하지 않는다. 회사·역할은 매 요청 세션과 DB 소속으로 확인한다.

사용자·품목 API는 `Cache-Control: no-store`를 반환한다. 오류 형식은 `{ error: code }`이고 `UNAUTHENTICATED`(401), `MEMBERSHIP_REQUIRED`·`ROLE_FORBIDDEN`(403), `NOT_FOUND`(404), 내부 오류 상세를 감춘 `SERVICE_UNAVAILABLE`(503)을 사용한다.

회원가입은 비활성화한다. 인증 요청은 Better Auth의 출처·요청 제한 규칙을 유지하며 신뢰하지 않는 origin은 403, 요청 제한에 도달하면 429를 반환한다. 라이브러리 인증 경로의 오류 본문은 자체 형식을 따른다. 앱의 관리자 사용자 생성 API는 제공하지 않는다.

## 2. 단계별 업무 API

1~6단계 경로를 구현했다. 아래 과거 단계별 계약 중 조회 목록은 10절의 페이지·검색 계약으로 확장한다.

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
- 생성 입력은 `{ code, name }`, 위치는 `warehouse_id`도 필요하다. 품목은 선택적 `min_stock`(기본 0)을 받는다. 활성 상태는 true로 생성한다.
- PATCH는 `code`, `name`, `active` 중 하나 이상을 받으며 품목에는 `min_stock`도 허용한다. 위치의 소속 창고는 변경할 수 없다. 알려지지 않은 필드는 거절한다.
- 코드는 앞뒤 공백 제거·대문자 변환 후 1~64자, 이름은 앞뒤 공백 제거 후 1~128자다.
- 응답은 id/code/name/active, 품목은 min_stock 문자열, 위치는 warehouse_id도 포함한다. 목록은 코드순 최대 1,000개이며 위치 목록에 `?warehouse_id=UUID` 필터를 지원한다.
- 회사 내 품목·창고 코드와 회사·창고 내 위치 코드가 고유하다. 초안이 참조하는 기준정보는 비활성화할 수 없다. 활성 위치가 있는 창고도 비활성화할 수 없다. 비활성 창고에 위치를 생성·재활성화할 수 없다.

## 6. 2단계 전표 계약

일반 전표 API는 관리자·작업자가 이용한다. 6단계에서 조회자는 `view=history`를 지정한 확정 이력 목록·상세만 읽을 수 있다. 변경은 계속 403이다.

| 경로 | 입력 | 성공 응답 |
|---|---|---|
| `GET /api/documents` | 없음 | 200 `{ documents: [...], pagination }`, 작성 시각·ID 내림차순, 명세 제외 |
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

입고는 도착 보관위치만, 출고는 출발 보관위치(`source_location_id`)와 외부 배송정보를, 이동은 서로 다른 출발·도착 보관위치를 지정한다. 모든 위치는 선택한 창고에 속해야 한다. 품목은 중복 없이 1~20개이며 수량은 1~1,000,000,000 정수다. 메모는 최대 2,000자다. 생성·수정 시 모든 참조는 활성 상태여야 한다. 다른 회사·존재하지 않는·비활성 참조는 404 `REFERENCE_NOT_FOUND`로 처리한다.

전표는 DRAFT/version=1로 생성된다. 수정·취소 시 행 잠금 후 버전을 비교하고 성공하면 1 증가한다. 오래된 버전은 409 `VERSION_CONFLICT`, 취소 전표 변경은 409 `INVALID_STATE`다. 취소는 DRAFT→CANCELLED이며 명세를 유지한다. 상세 헤더와 명세는 같은 잠금 범위에서 읽는다. 초안 작업은 재고·원장을 생성하거나 변경하지 않는다.

업무 변경 요청은 `Content-Type: application/json`과 `BETTER_AUTH_URL`의 origin과 일치하는 `Origin` 헤더가 필요하다. 출처 불일치는 403 `ORIGIN_FORBIDDEN`, 잘못된 JSON/입력은 400 `INVALID_INPUT`, 코드 중복은 409 `CONFLICT`, 사용 중 비활성화는 409 `IN_USE`, 비활성 부모 창고는 409 `INACTIVE_REFERENCE`다. 인증된 회사만 사용하며 전표 본문에 넣은 `tenant_id`는 무시한다. 모든 업무 응답은 no-store다.

전표 목록의 검색·페이지네이션은 10절을 따른다. 기준정보 목록은 최대 1,000개 제한을 유지한다.


## 7. 3단계 입고 확정·재고 조회

### `POST /api/documents/{id}/post`

관리자·작업자만 호출한다. JSON 본문 `{ "version": 1 }`, 정상 Origin, `Idempotency-Key` 헤더가 필수다. 키는 영문·숫자·마침표·밑줄·콜론·하이픈 1~128자다. INBOUND/DRAFT, OUTBOUND/DRAFT, TRANSFER/DRAFT를 처리한다. 이동은 같은 창고의 서로 다른 두 위치를 사용한다.

성공 200 응답은 `{ document: { id, status: "POSTED", version, posted_at }, ledger_entries }`다. 전표 버전은 1 증가한다. 입고는 도착 위치의 현재고를 늘리고 양수 원장·POST_INBOUND 감사를 기록한다. 출고는 출발 위치의 현재고를 차감하고 음수 원장·POST_OUTBOUND 감사를 기록한다. 감사 기록은 처리자·전표·시각을 포함한다.

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

현재고와 원장 목록은 10절의 페이지 처리를 적용하며 원장은 생성 시각·ID 내림차순이다. 대조는 목록 제한과 무관하게 회사 전체를 단일 SQL 스냅샷으로 비교하며 누락된 잔량·원장도 포함한다. 불일치를 보고할 뿐 자동 보정하지 않는다. 조회자에게 전표 초안 API는 계속 차단한다. 감사 기록 조회는 관리자 전용 `/api/audit-logs`와 `/dashboard/audit`에서 제공한다.

화면은 저장된 입고·출고·이동 초안만 확정한다. 미저장 변경이 있으면 먼저 저장해야 한다. 결과를 받지 못한 요청의 키·버전을 sessionStorage에 보관하고 같은 요청 재시도와 상태 새로고침을 제공한다. 재고가 있는 품목·위치·창고는 비활성화할 수 없다.


## 8. 4단계 출고 확정 및 참고 재고

출고 확정도 `POST /api/documents/{id}/post`와 기존 `{ version }`, `Idempotency-Key` 계약을 사용한다. 요청에서 유형이나 위치를 다시 지정하지 않고 잠근 전표의 저장값을 사용한다. 출발 위치의 모든 명세 잔량을 품목 ID 순서로 잠근 뒤 전체 수량을 검사한다.

잔량 행이 없거나 수량이 부족한 품목이 하나라도 있으면 409 `{ error: "INSUFFICIENT_STOCK" }`를 반환한다. 일부 품목만 출고하지 않으며 잔량·원장·전표 버전/상태·감사·성공 응답이 모두 미변경이다. 실패한 키는 성공 기록으로 남기지 않는다. 수량을 수정·저장한 뒤 새 버전으로 다시 확정할 수 있다. 단순 재시도는 같은 키·버전을 유지한다.

확정 트랜잭션의 잠금 대기는 개별 획득당 1초다. 잠금 시간 초과/교착 등은 전체 롤백 후 503 RETRYABLE_TRANSACTION으로 구분하며 같은 키·버전으로 재시도한다. 자동 재시도나 새 키를 만들어 재시도하는 동작은 없다. P3 입고 키의 해시 계약은 그대로 유지한다.

`GET /api/stock`은 선택적으로 `location_id`, `item_id` UUID 필터를 받으며 둘을 지정하면 정확한 위치·품목 잔량을 조회한다. 잘못된 UUID는 400 INVALID_INPUT, 자신의 회사에서 없는 조합이나 타 회사 ID는 빈 stock 배열이다. 필터는 회사 권한을 대체하지 않는다.

출고 화면은 각 품목을 위 필터로 조회하여 참고 재고를 표시한다. 조회 실패·조회 중을 0으로 표시하지 않는다. 이 값은 예약이 아니며 최종 출고 여부는 서버가 확정 시 잠근 잔량으로 판단한다. 부족 오류 후 수정·저장할 수 있고, 응답 유실 시 같은 요청 재시도 기능은 입고와 동일하다.


## 9. 5단계 내부 이동과 확정 취소

### 이동 확정

`POST /api/documents/{id}/post`의 기존 `{ version }`·Idempotency-Key 계약으로 TRANSFER 초안을 확정한다. 출발 위치의 음수 원장과 도착 위치의 양수 원장을 같은 트랜잭션으로 기록한다. `ledger_entries`는 품목 수의 두 배다. 동일 위치·다른 창고 이동을 거절한다. 잔량 부족·상한 초과 시 전표 전체를 미반영한다. 감사 동작은 POST_TRANSFER다.

### `POST /api/documents/{id}/reverse`

관리자만 허용한다. JSON `{ "version": 2 }`, 정상 Origin, Idempotency-Key가 필수다. 원본 POSTED 전표 전체를 취소하며 부분 취소는 제공하지 않는다. version 외 입력 필드(부분 명세 등)는 400 INVALID_INPUT으로 거절한다. 성공 200 예시는 다음과 같다.

```json
{
  "document": { "id": "원본 UUID", "status": "REVERSED", "version": 3, "reversed_at": "ISO 8601" },
  "reversal": { "id": "반대 전표 UUID", "status": "POSTED", "version": 1, "posted_at": "ISO 8601" },
  "ledger_entries": 2
}
```

- 원본 원장을 수정·삭제하지 않고 각 증감의 반대 수량을 새 전표의 원장으로 기록한다. 원본 확정 시각은 보존하고 취소 시각을 별도로 저장한다.
- 입고의 반대 전표는 출고, 출고의 반대 전표는 입고다. 이동의 반대 전표는 출발·도착 위치를 교환한 이동이다. 명세 수량은 양수로 유지한다.
- 원본은 REVERSED/version+1, 반대 전표는 POSTED/version=1이며 reversal_of_id로 원본에 연결된다. 원본 하나에 반대 전표 하나만 허용한다. 반대 전표의 수정·초안 취소·재확정·재취소를 허용하지 않는다.
- 입고 취소는 원래 도착 위치에서 차감한다. 이동 취소는 원래 도착 위치에서 차감하고 원래 출발 위치에 복구한다. 필요한 잔량이 부족하면 409 INSUFFICIENT_STOCK이며 모두 롤백한다. 출고 취소는 원래 출발 위치에 복구하며 누적 상한 검사를 유지한다.
- 과거 확정 취소는 비활성 품목·위치·창고 참조를 허용한다. 비활성 기준정보를 다시 활성화하지는 않는다. 신규 확정은 계속 활성 참조만 허용한다.
- 현재 관리자 권한·회사·원본 접근을 확인한 후 같은 키·같은 요청을 재반환한다. 다른 내용으로 같은 키 사용은 409 IDEMPOTENCY_CONFLICT, 오래된 버전은 409 VERSION_CONFLICT, 이미 취소된 원본 또는 반대 전표는 409 INVALID_STATE다. 다른 키로 중복 취소하면 추가 반영하지 않는다.
- 기존 확정 요청의 같은 키 재반환은 과거 성공 응답을 반환할 수 있다. 현재 상태는 상세를 다시 조회한다. REVERSED 원본에 새 키로 확정을 요청하면 거절한다.
- 감사 동작은 원본 ID의 REVERSE_DOCUMENT다. 반대 전표·원장·잔량·원본 상태·감사·요청 결과가 함께 커밋되며 잠금/서버 오류는 기존 재시도 규칙을 따른다.

전표 상세에는 `reversal_of_id`, `reversal_document_id`, `reversed_at`, `posted_at`이 포함된다. 원본 상세의 reversal_document_id로 반대 전표를, 반대 전표 상세의 reversal_of_id로 원본을 조회한다. 일반 목록·상세는 관리자·작업자에게 제공하며, `view=history` 목록·상세는 모든 역할에 확정 이력만 제공한다.

관리자 화면은 확정 취소와 반대/원본 전표 열기를 제공한다. 취소 요청의 키·버전도 통신 실패 시 sessionStorage에 보존하고 동일 요청 재시도 또는 상태 재조회를 제공한다.


## 10. 6단계 검색·페이지·확정 이력

모든 회사는 현재 인증 소속으로 결정한다. 아래 목록은 `page`(기본 1), `page_size`(기본 25, 최대 100)를 받으며 양의 정수만 허용한다. 응답은 기존 `documents`/`stock`/`entries` 배열과 `pagination: { page, page_size, total, total_pages }`다. 결과가 없으면 배열은 비고 total/total_pages는 0이다. 전체 건수와 해당 페이지는 단일 SQL 스냅샷에서 읽는다.

| 경로 | 적용 필터 | 검색어 `q` 대상 | 역할 |
|---|---|---|---|
| `/api/documents` | warehouse_id, location_id(출발 또는 도착), item_id, kind, status, date_from, date_to, date_field | 전표 ID·메모·명세 품목 코드/이름 | 관리자·작업자 |
| `/api/documents?view=history` | 위와 동일, status는 POSTED/REVERSED만 | 위와 동일 | 모든 역할 |
| `/api/stock` | warehouse_id, location_id, item_id | 품목 코드·이름 | 모든 역할 |
| `/api/stock-ledger` | warehouse_id, location_id, item_id, document_id, kind, status, date_from, date_to | 품목 코드·이름·전표 ID | 모든 역할 |
| `/api/audit-logs` | document_id, action, date_from, date_to | 전표 ID·동작·처리자 이름 | 관리자 |

`q`는 앞뒤 공백을 제거한 최대 100자 부분 검색이며 `%`, `_`, 역슬래시는 문자 그대로 검색한다. ID 필터는 UUID다. 날짜는 실제 존재하는 `YYYY-MM-DD`이고 시작일이 종료일보다 늦으면 400 INVALID_INPUT이다. 서울 시간의 시작일 00:00 이상, 종료일 다음 날 00:00 미만으로 조회하므로 UI의 종료일 전체가 포함된다. 전표 `date_field`는 created_at(기본)/posted_at/reversed_at이며 원장·감사는 created_at 기준이다. 현재고에는 날짜 필터를 적용하지 않는다. kind는 INBOUND/OUTBOUND/TRANSFER, status는 DRAFT/CANCELLED/POSTED/REVERSED다. 잘못된 형식·범위는 400 INVALID_INPUT이다.

`GET /api/documents/{id}?view=history`도 모든 역할에 허용하되 POSTED/REVERSED만 반환한다. 자사 초안·초안 취소 상세는 403 ROLE_FORBIDDEN이며 타 회사 상세는 404다. 이력 목록에 DRAFT/CANCELLED를 요청하면 403 ROLE_FORBIDDEN이다. 조회자가 `view=history` 없이 일반 목록·상세를 요청하면 403이다. `/dashboard/history`는 관리자에게도 읽기 전용이며 초안 관리 화면 `/dashboard/documents`는 조회자에게 접근 오류를 표시한다. 원본과 반대 전표 연결을 따라 상세를 조회할 수 있다.

`GET /api/audit-logs`의 entries는 `{ id, document_id, actor_id, actor_name, action, created_at }`이며 생성 시각·ID 내림차순이다. `GET /api/lookups`는 모든 역할에 자사 `{ warehouses: [{ id, code, name, active }], locations: [{ id, warehouse_id, code, name, active }] }`를 반환한다. 각 배열은 코드·ID순 최대 1,000개로, 비활성 기준정보도 과거 이력 필터에 사용한다. 기준정보 관리 API의 조회자 제한은 그대로 유지한다.

품목 POST/PATCH에 선택적 `min_stock`을 받는다. JSON 숫자 정수 0~1,000,000,000만 허용하며 생성 생략값은 0이다. 관리자만 변경할 수 있다. 품목 응답의 min_stock과 재고·원장 수량은 문자열이다. 창고·위치에는 min_stock을 받지 않는다.

## 11. 6단계 대시보드

`GET /api/dashboard`는 모든 역할이 자사 범위에서 호출하며 요청의 회사·시계 값은 사용하지 않는다. 서버 현재 시각의 `as_of`(ISO 8601), `timezone: "Asia/Seoul"`, 아래 데이터를 하나의 SQL 스냅샷으로 반환한다.

- `metrics`: stocked_items, today_inbound, today_outbound, today_reversals, pending_outbound, low_stock_items. 모든 값은 건수 숫자다.
- `daily`: 오늘 포함 최근 7일을 날짜 오름차순으로 `{ date: "YYYY-MM-DD", inbound, outbound, reversals }` 반환한다. 실적 없는 날도 0으로 포함한다.
- `low_stock`: 코드·ID순 최대 20개의 `{ id, code, name, min_stock, quantity }`. 수량은 문자열이다.
- `recent`: 최근 처리 시각(reversed_at 우선, 없으면 posted_at)·ID 내림차순 최대 10개의 `{ id, kind, status, posted_at, reversed_at, reversal_of_id }`. 모든 역할에 POSTED/REVERSED만 제공한다.

입출고 실적은 반대 전표를 제외한 원본 POSTED/REVERSED 전표의 posted_at 기준 건수이며 품목 수량 합계가 아니다. 나중에 취소되어도 원래 확정일의 실적을 유지한다. 확정 취소는 원본 reversed_at 날짜에 별도 집계하며 반대 전표를 신규 입출고 실적으로 중복 계산하지 않는다. 이동은 입출고 건수에서 제외한다. 출고 대기는 DRAFT 출고 건수로 조회자에게도 집계만 제공한다.

재고 보유 품목은 활성 여부와 무관하게 회사 전체 위치 수량 합계가 0보다 큰 품목 수다. 부족 품목은 활성 품목의 회사 전체 위치 합계가 min_stock보다 작은 경우다. 잔량 행이 없으면 0으로 포함하며 비활성 품목은 부족 집계에서 제외한다. 모든 업무 응답은 no-store이며 실패 시 성공 데이터나 0으로 대체하지 않는다.

화면은 로딩·빈 결과·오류를 구분하고 저장된 전표의 확정/확정 취소 전에 품목·위치·수량 확인 창을 제공한다. 최종 검증과 별도 `npm run test:performance` 측정 근거는 [6단계 검증 결과](6단계-검증결과.md), [6단계 성능 측정](6단계-성능측정.md)에 기록한다.


## 출고처·배송지 보완 (2026-10-20)

출고는 창고 내부 도착 위치 대신 받는 거래처와 외부 배송지를 기록한다. 주소록 선택 방식은 아래 절을 따른다. 이전 클라이언트가 `delivery_destination_id`를 생략하면 `POST /api/documents`와 초안 `PATCH /api/documents/{id}`의 OUTBOUND에 `recipient_name`(받는 거래처, 최대 128자), `delivery_address`(배송지, 최대 500자)를 모두 요구한다. 문자열의 앞뒤 공백을 제거하고 빈 값·잘못된 형식·길이 초과는 400 INVALID_INPUT이다. INBOUND/TRANSFER에는 비어 있거나 null인 값만 허용하며 null로 저장한다.

```json
{
  "kind": "OUTBOUND",
  "warehouse_id": "창고 UUID",
  "source_location_id": "출발 보관위치 UUID",
  "recipient_name": "시연 납품처",
  "delivery_address": "서울 시연구 물류로 100 (합성 배송지)",
  "lines": [{ "item_id": "품목 UUID", "quantity": 3 }]
}
```

목록·상세·확정 이력에 두 필드를 반환하고 전표 검색어 q로 거래처와 주소도 검색한다. 초안에서만 수정하며 변경 후 다시 저장해야 확정할 수 있다. 확인창에는 출발 보관위치·출고처·배송지를 함께 표시한다.

기존 확정 전표의 미등록 정보는 null로 보존하며 기록을 소급 수정하지 않는다. 기존 출고 초안은 두 항목을 채워 저장한 뒤 확정한다. 저장값이 누락된 초안의 확정은 재고 변경 없이 400 DELIVERY_REQUIRED다. 이미 성공한 멱등 요청은 과거 배송정보가 null이어도 기존 응답을 반환한다. 확정 취소의 반대 전표는 재고를 되돌리는 기록이므로 배송지 없이 생성할 수 있고 원본 배송정보는 유지한다.

## 배송지 주소록과 출고 선택

`GET /api/delivery-destinations`는 관리자·작업자에게 같은 회사의 활성 배송지를 반환한다. `q`는 거래처명·배송지 이름·주소·우편번호를 문자 그대로 부분 검색한다(최대 100자). `page=1`, `page_size=20`이 기본이며 최대 100개다. `include_inactive=true`는 관리자만 사용할 수 있다. 응답은 `{ destinations, pagination: { page, page_size, total, total_pages } }`다.

각 배송지는 `{ id, tenant_id, recipient_name, name, postal_code, address_line1, address_line2, active, created_at, updated_at, delivery_address }`다. `delivery_address`는 기본 주소와 비어 있지 않은 상세주소를 공백으로 결합한 값이다. 전표 저장 때 주소를 복사하므로 이후 주소록 수정은 과거 전표에 반영되지 않는다.

`POST /api/delivery-destinations`와 `PATCH /api/delivery-destinations/{id}`는 관리자만 변경할 수 있고 Origin 검사를 유지한다. 생성 입력은 `{ recipient_name, name, postal_code?, address_line1, address_line2? }`, 수정은 같은 필드 중 변경할 필드와 선택적 `active`다. 알 수 없는 필드, 빈 수정, 길이 초과, 잘못된 우편번호는 400이며 회사 안의 거래처명/배송지 이름 중복은 409다. 생성 201, 수정 200으로 `{ destination }`을 반환한다. 상세 GET은 관리자·작업자에게 허용하고 작업자에게 비활성은 404다. 다른 회사의 ID는 조회/수정 모두 404이며 조회자의 모든 주소록 요청은 403이다.

출고 전표 POST/PATCH에 `delivery_destination_id`(UUID)를 지정하면 서버가 해당 회사의 활성 주소록을 읽어 `recipient_name`, `delivery_address`를 결정한다. 함께 보낸 텍스트는 사용하지 않는다. 없는 ID·다른 회사·비활성 배송지는 404 REFERENCE_NOT_FOUND다. 입고·이동에는 null/생략만 허용한다. 전표 응답에는 nullable `delivery_destination_id`가 포함된다. 이전 텍스트 전표도 기존 스냅샷으로 조회·수정·확정할 수 있다.

화면은 출고에서 검색 결과를 선택하며, 관리자는 같은 화면의 ‘새 배송지 등록’ 또는 ‘배송지 관리’에서 등록·수정할 수 있다. 등록 시 Daum 우편번호 검색으로 기본 주소를 선택하고 상세주소만 입력한다. 외부 검색은 사용자 클릭 때 불러오며 로딩 실패 시 재시도를 제공한다. API 키나 유료 지도 상품 설정은 필요하지 않다.
