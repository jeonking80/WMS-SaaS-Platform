# WMS Lite DB 설계

## 0단계 구현 범위

PostgreSQL 17, `pg` SQL 접근, `node-pg-migrate` SQL 마이그레이션으로 시작한다. 이번 단계는 실제 DB 연결·최초 테이블·재실행을 검증하는 기반이다. 인증·회사별 접근 제한·재고 처리의 구현 완료를 의미하지 않는다.

| 테이블 | 컬럼 | 제약·기본값 |
|---|---|---|
| `tenants` | `id` | UUID PK, `gen_random_uuid()` |
| | `name` | varchar(128), NOT NULL, 공백만 있는 이름 금지 |
| | `active` | boolean, NOT NULL, 기본 true |
| | `created_at` | timestamptz, NOT NULL, 현재 시각 |
| `pgmigrations` | 도구 관리 이력 | 적용한 버전 기록, 동일 버전 재적용 방지 |

회사명은 고유 식별자로 사용하지 않는다. 모든 참조는 UUID를 사용한다. 시각은 `timestamptz`로 저장하고 사용자 표시는 `Asia/Seoul` 기준으로 처리한다.

## 로컬 DB와 명령

`.env.local`에 `POSTGRES_PASSWORD`를 설정한다. 비밀값은 저장소에 커밋하지 않는다. URL 비밀번호의 특수문자는 URL 인코딩한다. 예시 파일의 빈 변수에는 실제 로컬 접속정보를 채워야 한다.

```sh
docker compose --env-file .env.local --profile test up -d --wait
npm run db:migrate
npm run db:check
npm run db:seed
npm run test:integration
```

- 개발 DB: `wms_lite`, 기본 포트 5432, 영속 볼륨.
- 테스트 DB: `wms_lite_test`, 기본 포트 5433, `test` 프로필과 임시 메모리 볼륨. 컨테이너를 재생성하면 테스트 데이터가 초기화된다.
- 두 포트는 localhost에만 노출한다. 다른 프로젝트의 DB와 연결하지 않는다.
- `MIGRATION_DATABASE_URL`: 마이그레이션·개발 시드 접속. 현재 로컬 bootstrap은 Compose의 `postgres` 계정이다.
- `DATABASE_URL`: 앱 연결·연결 확인용. 0단계에서는 연결 상태만 검사한다.
- `TEST_DATABASE_URL`: 통합 테스트 전용. DB명이 `_test`로 끝나야 실행된다.
- `POSTGRES_PASSWORD`: Compose 초기 DB 암호. 이미 초기화된 개발 볼륨에서는 이 변수를 바꿔도 기존 역할의 암호가 바뀌지 않는다.

마이그레이션은 한 트랜잭션에서 실행되고 도구의 잠금 기능을 유지한다. `npm run db:migrate`는 순방향 적용만 제공한다. 이미 적용한 파일을 수정하지 말고 새 버전의 파일을 추가한다. Down SQL은 별도 복구 검토를 위한 것이며 기본 실행 흐름에 포함하지 않는다.

개발 시드는 합성 회사 A/B만 생성하며, 고정 UUID와 `ON CONFLICT DO NOTHING`으로 반복 실행할 수 있다. 비밀번호·사용자·재고는 생성하지 않는다. 회사 ID를 고정한 이 시드는 독립 개발 DB에서만 실행한다. production 모드에서는 실행을 거절한다. 실제 초기 재고는 후속 입고 확정 서비스로 생성한다.

## 통합 검증

실제 PostgreSQL 테스트 DB에 임의 이름의 전용 스키마를 만들고 아래를 확인한 후 해당 스키마만 삭제한다. 테스트 DB나 public 스키마를 초기화하지 않는다.

1. 빈 스키마에 마이그레이션 적용 시 최초 버전 한 개가 실행된다.
2. 회사 삽입 시 UUID·활성값·생성 시각이 생성된다.
3. 다시 마이그레이션하면 적용 건수는 0이며 기존 데이터와 이력이 유지된다.
4. 공백뿐인 회사명·NULL 회사명은 DB 제약으로 거절된다.

환경변수가 없거나 실제 DB에 접속할 수 없으면 검증을 건너뛰지 않고 실패한다. 테스트 통과는 1단계의 RLS·인증 검증과 구분한다.

## 1단계로 이어질 권한 설계

현재 Compose `postgres`는 로컬 DB 초기화를 위한 관리자 계정이다. 이 계정을 운영 앱 연결에 사용하지 않는다. 인증/업무 API를 구현하기 전에 다음을 함께 완료한다.

- 마이그레이션용 소유자 역할과 앱 로그인 역할 분리. 앱 역할은 `NOSUPERUSER`, `NOBYPASSRLS`이며 테이블 소유자가 아니어야 한다.
- 역할 암호는 안전한 환경 설정에서 제공하고 SQL 마이그레이션 파일에 기록하지 않는다.
- 일반 앱에 스키마 생성이나 마이그레이션 이력 쓰기 권한을 부여하지 않는다.
- 회사 업무 테이블에 `tenant_id`, 복합 참조 제약과 RLS 적용. 회사 컨텍스트는 체크아웃한 연결의 트랜잭션에서 `SET LOCAL` 범위로만 설정한다.
- 인증·회사·소속 조회는 인증 라이브러리와 결정한 신뢰 경계에 맞춰 별도 설계한다. `tenants`를 모든 로그인 사용자에게 무제한 조회하도록 공개하지 않는다.
- A/B 회사 교차 요청, 회사 컨텍스트 누락, 커밋·롤백 후 연결 재사용을 실제 앱 역할로 검증한다.
- 원장 테이블은 필요한 SELECT/INSERT만 허용하고 UPDATE/DELETE/TRUNCATE는 허용하지 않는다.

아직 `tenants`에는 RLS나 앱 권한을 부여하지 않았다. 외부 업무 엔드포인트가 생기기 전 위 사항을 구현하며, 지금 단계의 관리자 DB 테스트를 회사 격리 테스트로 보고하지 않는다.
