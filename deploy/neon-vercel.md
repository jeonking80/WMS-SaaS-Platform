# Neon SQL Editor로 빈 데모 DB 준비

무료 개인 시연 대상으로 Vercel Hobby와 Neon Free를 선택했다. 실제 제공 한도와 비상업적 사용 조건은 가입 시 확인한다. 이 문서는 현재 사용자의 Neon `wms_demo` DB를 초기화하는 단계다. 사용자 콘솔에서 Neon 초기화 결과 7/16/9와 wms_app 로그인 허용·비관리자·RLS 우회 불가를 확인했고, 공개 Vercel 로그인 화면도 확인했다. 앱 계정·합성 데이터의 실제 Neon 적용과 공개 로그인 검증은 다음 단계다.

## 초기화

1. Neon SQL Editor에서 DB `wms_demo`, DB 소유자 계정을 선택한다. 이번 확인 결과는 `neondb_owner`, CREATEROLE=true, public 테이블 0개다.
2. [neon-init.sql](neon-init.sql) 전체를 복사한다. GitHub에서는 파일의 Raw 버튼으로 원문을 연다.
3. 예제 SQL을 지우고 전체 내용을 한 번에 실행한다. BEGIN/SET LOCAL/COMMIT를 부분 실행하지 않는다.
4. 마지막 결과가 migrations_applied=9, tables_created=17, forced_rls_tables=10인지 확인한다.

설치기는 저장소의 9개 Up Migration만 순서대로 포함한다. Down Migration이나 비밀번호는 포함하지 않는다. 새 wms_migrator가 테이블을 소유하고 wms_app은 제한된 읽기·업무 변경 권한만 받는다. 두 역할은 NOLOGIN으로 생성된다. 이후 앱 로그인용 DB 비밀번호는 사용자가 비공개로 설정해야 한다. 앱 사용자 계정과 합성 데이터도 별도 준비가 필요하다.

DB 이름이 다르거나 public 스키마에 테이블·뷰·시퀀스 등이 있거나 역할이 이미 있으면 실패하며 기존 대상을 변경하지 않는다. 재실행으로 덮어쓰지 않는다. 성공 후 앞으로 새 마이그레이션을 적용할 수 있도록 node-pg-migrate와 동일한 pgmigrations 메타데이터를 기록한다.

## 생성 및 검증

```sh
node scripts/generate-neon-sql.mjs
node scripts/verify-neon-init.mjs
```

검증은 임의 이름의 전용 PostgreSQL 17 컨테이너를 만들고 슈퍼유저 권한이 없는 CREATEROLE DB 소유자로 전체 SQL을 실행한다. 9개 적용 이력·17개 테이블·10개 강제 RLS, 실제 wms_app 인증과 권한, 기존 설치 덮어쓰기 거절, 후속 마이그레이션 0건을 확인한 뒤 해당 컨테이너를 제거한다. 실제 Neon 서버에서의 결과는 사용자의 SQL Editor 실행 후 별도로 확인한다. 로컬 검증을 외부 적용 완료로 표현하지 않는다.

Vercel 웹 앱에는 neondb_owner 또는 wms_migrator 연결을 넣지 않는다. DATABASE_URL은 wms_app, BETTER_AUTH_SECRET은 별도 난수, BETTER_AUTH_URL은 실제 HTTPS 배포 주소를 사용한다. Neon의 pooled 연결은 웹용, direct 연결은 마이그레이션용으로 구분한다. Vercel 서버리스의 인증 요청 제한 저장 방식과 DB 유휴 복귀는 실제 연결 후 검증해야 한다.


## 서버 지역

Neon DB는 AWS Asia Pacific 1 (Singapore)에 있다. 저장소 루트의 `vercel.json`이 Vercel 서버 함수 지역을 같은 싱가포르(`sin1`)로 고정한다. 보호 API 한 번은 로그인 확인·창고 권한·조회·요청 기록 트랜잭션으로 DB를 20~30회 순서대로 오가므로, 서버와 DB가 다른 대륙(기본값 미국 동부 `iad1`)에 있으면 왕복 지연이 그 횟수만큼 곱해져 API 하나가 수 초씩 걸린다. Neon 지역을 옮기면 `vercel.json`의 지역도 같이 바꾼다.

## 초기 앱 계정·데모 데이터

빌드된 앱이 있는 작업공간에서 다음 명령으로 비공개 파일을 생성한다.

```sh
node scripts/generate-neon-demo.mjs
```

`artifacts/neon-demo-seed.sql`에는 비밀번호 원문 대신 Better Auth 공식 해시가 들어간다. `artifacts/neon-demo-credentials.txt`에는 서로 다른 무작위 초기 비밀번호가 들어가며, 두 파일은 권한 600·Git/Docker 제외 상태다. 기존 파일은 덮어쓰지 않는다. 공개 저장소나 채팅에 파일 내용을 올리지 않는다.

SQL 전체를 Neon의 wms_demo DB 소유자 계정으로 실행한다. 기존 초기화 SQL을 다시 실행하는 것이 아니다. 마지막 SELECT의 `demo_users=3`, `credential_accounts=3`을 확인한 후 비공개 파일의 관리자 이메일·비밀번호로 앱에 로그인한다. 공개 시연에 공유할 수 있는 계정은 조회자뿐이다.

새 SQL은 3개 앱 계정, 품목 3개, 전표 6개, 원장 6행, 잔량 4행, 감사 5행을 한 트랜잭션으로 만든다. 기존 계정·활동을 발견하면 거절하며 재설정하지 않는다. 원장과 잔량 및 확정 전표 효과를 커밋 전에 대조한다. 원래 CLI 데모 시드와 SQL Editor 경로는 같은 매개변수화된 fixture 정의를 사용한다.

```sh
node scripts/verify-neon-demo.mjs
```

이 검증은 별도 PostgreSQL 17과 기존 프로덕션 빌드로 SQL 적용·반복 거절·기존 CLI 시드 호환·세 역할 실제 로그인·역할 제한·원장 대조를 확인한다. 사용자 Neon DB에 직접 접속하지 않는다.


## 기존 앱의 출고처·배송지 업데이트

이미 계정·재고가 있는 wms_demo에는 [neon-outbound-delivery.sql](neon-outbound-delivery.sql) 전체를 DB 소유자의 SQL Editor에서 실행한다. 마지막 결과가 delivery_ready=true, delivery_columns=2여야 한다. 계정·수량·원본 전표는 바꾸지 않는다. 입력 기능을 배포하기 전에 DB 업데이트 결과를 확인한다. 새 출고에는 받는 거래처와 배송지를 입력하고, 기존 출고 초안은 정보를 채운 뒤 저장한다. 과거 확정 전표는 수정하지 않는다.


## 기존 앱의 검색·선택형 배송지 주소록 업데이트

출고처 필드 추가가 끝난 기존 DB에는 [neon-delivery-destinations.sql](neon-delivery-destinations.sql) 전체를 `wms_demo` SQL Editor의 DB 소유자로 실행한다. 마지막 결과 `address_book_ready=true`, `tenant_isolation_ready=true`를 확인한다. 계정·기존 전표·재고를 초기화하지 않는다. 기존 전표의 300자 이하 주소는 거래처별로 중복 없이 주소록에 복사하므로 출고에서 재선택할 수 있다. 더 긴 주소는 원본에 보존하고 자동 주소록 복사에서만 제외한다.

신규 UI/API는 이 DB 작업 완료 후 배포한다. 작업 전에는 SQL·설정 도구만 main에 게시하고 앱 코드는 `feat/destination-address-book` 브랜치에 둔다. 새 화면에서 출고 → 거래처·배송지 검색 → 결과 선택 → 전표 저장 순서로 사용한다. 새 주소는 관리자가 ‘새 배송지 등록’ → ‘주소 검색’으로 한 번 등록한다. 무료 우편번호 검색 SDK는 사용자가 주소 검색을 누를 때 브라우저에서 로드하며 앱의 API 키나 추가 유료 플랜은 요구하지 않는다.

```sh
node scripts/generate-neon-destinations-upgrade.mjs
node scripts/verify-neon-init.mjs --destinations-upgrade
```
