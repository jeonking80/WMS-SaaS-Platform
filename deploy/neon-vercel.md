# Neon SQL Editor로 빈 데모 DB 준비

무료 개인 시연 대상으로 Vercel Hobby와 Neon Free를 선택했다. 실제 제공 한도와 비상업적 사용 조건은 가입 시 확인한다. 이 문서는 현재 사용자의 Neon `wms_demo` DB를 초기화하는 단계다. Vercel 공개 배포와 로그인 검증은 아직 완료되지 않았다.

## 초기화

1. Neon SQL Editor에서 DB `wms_demo`, DB 소유자 계정을 선택한다. 이번 확인 결과는 `neondb_owner`, CREATEROLE=true, public 테이블 0개다.
2. [neon-init.sql](neon-init.sql) 전체를 복사한다. GitHub에서는 파일의 Raw 버튼으로 원문을 연다.
3. 예제 SQL을 지우고 전체 내용을 한 번에 실행한다. BEGIN/SET LOCAL/COMMIT를 부분 실행하지 않는다.
4. 마지막 결과가 migrations_applied=7, tables_created=16, forced_rls_tables=9인지 확인한다.

설치기는 저장소의 7개 Up Migration만 순서대로 포함한다. Down Migration이나 비밀번호는 포함하지 않는다. 새 wms_migrator가 테이블을 소유하고 wms_app은 제한된 읽기·업무 변경 권한만 받는다. 두 역할은 NOLOGIN으로 생성된다. 이후 앱 로그인용 DB 비밀번호는 사용자가 비공개로 설정해야 한다. 앱 사용자 계정과 합성 데이터도 별도 준비가 필요하다.

DB 이름이 다르거나 public 스키마에 테이블·뷰·시퀀스 등이 있거나 역할이 이미 있으면 실패하며 기존 대상을 변경하지 않는다. 재실행으로 덮어쓰지 않는다. 성공 후 앞으로 새 마이그레이션을 적용할 수 있도록 node-pg-migrate와 동일한 pgmigrations 메타데이터를 기록한다.

## 생성 및 검증

```sh
node scripts/generate-neon-sql.mjs
node scripts/verify-neon-init.mjs
```

검증은 임의 이름의 전용 PostgreSQL 17 컨테이너를 만들고 슈퍼유저 권한이 없는 CREATEROLE DB 소유자로 전체 SQL을 실행한다. 7개 적용 이력·16개 테이블·9개 강제 RLS, 실제 wms_app 인증과 권한, 기존 설치 덮어쓰기 거절, 후속 마이그레이션 0건을 확인한 뒤 해당 컨테이너를 제거한다. 실제 Neon 서버에서의 결과는 사용자의 SQL Editor 실행 후 별도로 확인한다. 로컬 검증을 외부 적용 완료로 표현하지 않는다.

Vercel 웹 앱에는 neondb_owner 또는 wms_migrator 연결을 넣지 않는다. DATABASE_URL은 wms_app, BETTER_AUTH_SECRET은 별도 난수, BETTER_AUTH_URL은 실제 HTTPS 배포 주소를 사용한다. Neon의 pooled 연결은 웹용, direct 연결은 마이그레이션용으로 구분한다. Vercel 서버리스의 인증 요청 제한 저장 방식과 DB 유휴 복귀는 실제 연결 후 검증해야 한다.
