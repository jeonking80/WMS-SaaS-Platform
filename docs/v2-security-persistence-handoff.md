# 보안 영속성 보강 인계 — 실행 전

현재 저장된 변경은 실행 검증 전이다. 실행 중인 25분 혼잡 시험은 이 변경 이전의 독립 사본을 사용하므로 새 변경의 통과 증거가 아니다.

## 배포 순서

1. 정식 `1792368000018_v2-security-persistence.sql`을 마이그레이터로 적용한다. 합계는 **19개 마이그레이션 / 41개 테이블**이며 회사별 FORCE RLS 33개는 유지된다. 인증 전 공유 저장소인 `rateLimit`은 `account`·`session`처럼 회사 미확정 상태에서 쓰므로 회사 RLS 대상이 아니다.
2. 기존 `db:bootstrap -- --grant`를 관리자 연결로 실행한다. 새 인증 테이블의 CRUD와 제한된 boolean 안전검사 함수 실행만 앱에 부여한다. 보호 함수 소유자는 `wms_migrator`로 맞추며 원본 검사 함수와 트리거 함수의 PUBLIC 실행 권한은 회수한다. 앱에 BYPASSRLS·추가 역할·전체 창고 조회 함수를 부여하지 않는다.
3. 새 앱을 배포한다. `/api/ready`는 새 인증 저장소의 필수 컬럼/읽기 권한도 확인한다. 마이그레이션 전 새 앱으로 전환하지 않는다.

별도 수동 DDL은 없다. 배포 SQL의 유일한 원본은 새 정식 마이그레이션이며 이미 적용한 0012는 수정하지 않았다. 보안 보호를 제거하는 자동 down은 금지하고 검토된 전진 마이그레이션을 사용한다.

## 변경의 의미

- 공유 기준정보 안전검사는 인증된 현재 회사와 인자가 같을 때만 실행한다. 고정 search_path에서 제한된 boolean 검사 중에만 창고 필터를 잠시 해제하고 정상·예외 경로 모두 복구한다. 숨은 창고의 행, 이름, 번호, 수량은 반환하지 않고 사용 중이면 기존 `MASTER_IN_USE`로만 차단한다. 직접 레거시 UPDATE와 바코드 중지도 같은 검사를 받는다.
- BetterAuth 1.7.11의 설치 소스 `get-tables` 스키마와 database limiter의 조건부 `incrementOne`/충돌 재시도에 맞춰 `rateLimit`을 저장한다. 기존 로그인 제한(3회/10초)을 완화하지 않는다. 프로세스 재시작 후에도 같은 제한 창을 사용한다. 테스트의 허용 3건은 올바른 로그인 성공이 아니라 잘못된 자격의 401까지 도달한 3건을 뜻한다.
- 역사 이름은 반환된 창고 원장·승인·배정·배송 사건·교대 보고서가 실제 참조한 ID만 회사 조건으로 조회한다. 퇴사 사람과 회수 키의 **현재 보존된 이름**을 반환하며 과거 시점 이름 스냅샷을 주장하지 않는다. 이메일/자격을 반환하지 않고 활성 배정 후보에 비활성 계정을 섞지 않는다.

## 실행 슬롯 이후 검증

새 PG 회귀: `auth-rate-limit.test.ts`(별도 두 Node 프로세스 동시 8건, 3건 401/5건 429, 세 번째 프로세스 재시작 제한, 만료 후 재허용), `v2-historical-actors.test.ts`(퇴사/회수 이름, 타회사 ID 이름 차단, 활성 후보 제외), `v2-masters.test.ts`의 숨은 창고 기준정보 안전검사(서비스/직접 UPDATE/문맥 복구/임시 테이블 shadow/내부 함수 실행 거부).

인증 회귀는 독립 무작위 스키마와 제한된 전용 DB 역할만 사용한다. 실제 브라우저 시험은 앱 서버를 다시 띄워도 같은 IP의 기존 인증 제한이 유지되므로 429의 대기 시간을 준수해야 한다. 테스트 편의를 위한 운영 제한 완화나 전역 limiter 삭제는 하지 않는다.

`verify-restore.mjs`와 `v2-recovery-replay.mjs`의 최신 검사는 19/41 및 limiter 보존으로 갱신했다. **기존 18/40 실제 복원 JSON은 과거 증거로 그대로 유지했다.** 새 빌드·마이그레이션 검증 후 두 드릴을 다시 실행해야 새 보강의 복원 근거가 생긴다. 로컬 동일 클러스터 복원이며 제공자/PITR/RPO/RTO 검증은 여전히 별도다.

## 저장본 해시

기록 시각: 2026-10-20T15:49:53.888067+00:00. 아래는 읽기만으로 계산한 SHA-256이며 테스트 통과 증거가 아니다. 공유 index/types 파일은 다른 담당자의 후속 편집이 있으면 최종 freeze에서 다시 계산한다.

| 파일 | SHA-256 |
|---|---|
| `db/migrations/1792368000018_v2-security-persistence.sql` | `f3593636a12b75be2791b52ba70774b663297e3eb5477a8f56345e2088dee555` |
| `src/server/auth/config.ts` | `3af07e6700ef7ddde8a164fe281c9b4f1c368a0a65c18d373e901d2ddc7be752` |
| `src/server/auth/rate-limit.mjs` | `3c2bfa50f43279f9bab60285bc8dfce4a289cf9edd282c1d00e8d20c0d4367be` |
| `src/server/auth/rate-limit.d.mts` | `af3c825a0053e0f3c5660cfacad52ccd95a94bb1feb8f6bad3cd2b00eb23bc09` |
| `src/app/api/ready/route.ts` | `6587f98cc80fa9f0e25e895bbd7bb0e8cccebe092dc7d8fef6f7b058f884eafc` |
| `src/server/v2/workflow/actor-names.ts` | `a876d54f7938e7962353f496d72f7a988052de3b82b60931457c056e3ee1e19d` |
| `src/server/v2/workflow/index.ts` | `366983dfbe8e68f373690d164d3282d474a1e70fa3e1640a24f70e6a7cadce0e` |
| `src/server/v2/workflow/types.ts` | `c4817905ee10514e06dc67752d11046f04ecc520db5f8c83919360c84ed690ba` |
| `src/app/dashboard/v2/ledger-ui.tsx` | `815128e02ba0f3ed8436d79a2ae10d45074ec81b75b73ef305df29d4413d5985` |
| `src/app/dashboard/v2/delivery-ui.tsx` | `32ce0620013837ecdfbd925697b80fc94a37023331632134cf2c3aa3fdef6ada` |
| `src/app/dashboard/v2/workflow-ui.tsx` | `ed7f387a5dd4ded8a22a370e8e6750e88998d283b03cbe033833247b36a91d92` |
| `scripts/db-bootstrap.mjs` | `abc79c79d493b50f3afc7a82cfd513793cb5379209c4b356e9b899db18e57508` |
| `scripts/verify-restore.mjs` | `f758cd2266a3d9ce39b0a0fc0d6759f3e4f1f6ea16a1a3ae9cb9dab71ead19f8` |
| `scripts/v2-recovery-replay.mjs` | `ff5221a6607661d193298278fdad26f994974b9d7f7a155c6249c1bd491b2479` |
| `tests/fixtures/auth-rate-limit-worker.mjs` | `64bbefad03e44f163dd64dffa387ed48294b7cd78e7098e1a474b6f07659490c` |
| `tests/integration/auth-rate-limit.test.ts` | `6baa60f2eb19b6a0a6bfafee4075fd82db5483919c87176df61df634d2ff9d9a` |
| `tests/integration/v2-historical-actors.test.ts` | `894adb77d7db873d4efeffe82bbe806b4cca8ff80f18978fa756d8d6fb47b9d7` |
| `tests/integration/v2-masters.test.ts` | `a4ce4c00fcf2132385377cc6be272d450a572ddc20e3c3e2a1bf67f030518300` |
