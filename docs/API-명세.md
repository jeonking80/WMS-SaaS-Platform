# WMS Lite API 명세

**상태:** 1단계 인증·회사 격리. 아래에 명시한 인증·사용자·품목 조회·상태 API를 제공한다. 품목 변경·전표·재고 API는 아직 없다.

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
| `GET /api/items` | 관리자·작업자의 자사 품목 조회. code/id 순서 최대 100개. 조회자는 403 |
| `GET /api/items/{id}` | 관리자·작업자의 자사 품목 상세. 없거나 타 회사 대상 또는 잘못된 UUID는 404 |

`/api/me` 응답은 `{ user: { id, name, email }, tenant: { id, name }, role }`이며 role은 admin/worker/viewer다. 품목 응답은 `{ items: [...] }`, `{ item: {...} }`이고 각 항목은 id/code/name/active만 포함한다. 요청의 `tenant_id`나 역할 헤더는 권한 판단에 사용하지 않는다. 회사·역할은 매 요청 세션과 DB 소속으로 확인한다.

사용자·품목 API는 `Cache-Control: no-store`를 반환한다. 오류 형식은 `{ error: code }`이고 `UNAUTHENTICATED`(401), `MEMBERSHIP_REQUIRED`·`ROLE_FORBIDDEN`(403), `NOT_FOUND`(404), 내부 오류 상세를 감춘 `SERVICE_UNAVAILABLE`(503)을 사용한다.

회원가입은 비활성화한다. 인증 요청은 Better Auth의 출처·요청 제한 규칙을 유지하며 신뢰하지 않는 origin은 403, 요청 제한에 도달하면 429를 반환한다. 라이브러리 인증 경로의 오류 본문은 자체 형식을 따른다. 앱의 관리자 사용자 생성 API는 제공하지 않는다.

## 2. 이후 확장할 업무 API

다음 표는 전체 개발 순서와 예정된 경로다. 위에서 구현 완료로 명시한 경로 외에는 해당 단계에서 요청·응답 스키마와 오류 코드를 확정한다.

| 단계 | API | 목적 |
|---|---|---|
| 1 | `/api/me`, 인증 라이브러리 경로 | 세션·사용자 소속·역할, 로그인·로그아웃 |
| 2 | `/api/items`, `/api/warehouses`, `/api/locations` | 기준정보 관리 |
| 2 | `/api/inventory-documents`, `/{id}`, `/{id}/cancel` | 전표 초안 작성·수정·조회·취소 |
| 3~4 | `/api/inventory-documents/{id}/post` | 입고·출고 확정 |
| 3~6 | `/api/stock`, `/api/stock-ledger` | 현재고 및 원장 조회 |
| 5 | `/api/inventory-documents/{id}/reverse` | 관리자 확정 취소 |
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

Playwright는 초기 화면·상태 API, 보호 화면의 로그인 필요 여부, 역할별 로그인·로그아웃, A→B 세션 전환, 가입·외부 origin 차단, 세션 만료, 역할 변경 즉시 반영, 회사 위조 요청과 품목 상세 404, 조회자 403을 검사한다. 실제 PostgreSQL에서는 비소유자·비관리자 역할로 RLS와 연결 재사용을 별도 검증한다. 전표·재고 업무 검증은 아직 실행하지 않는다.
