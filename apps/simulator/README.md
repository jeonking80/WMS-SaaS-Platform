# WMS 운영 시뮬레이터

WMS와 별도 프로세스·웹 UI·SQLite 저장소로 실행하는 Node24 앱이다. 추가 npm 의존성이 없다. WMS DB 연결 문자열을 받지 않으며, 모든 기준정보 준비·외부 공급·실물 작업·결과 조회는 버전2 API를 호출한다.

```bash
cd apps/simulator
cp .env.example .env
# .env의 등록된 시험 WMS 주소/회사 및 분리된 machine key를 설정
npm start
```

브라우저 `http://127.0.0.1:4310`. 운영환경과 운영회사는 연결할 수 없다. WMS 서버는 `WMS_ENVIRONMENT=test`, 회사는 `is_test=true`로 별도 준비해야 한다. 회사/최초 관리자/창고/권한/키 발급은 WMS의 승인된 준비 경로가 담당한다. 시뮬레이터는 이 권한을 갖지 않는다.

환경변수:

| 이름 | 의미 |
|---|---|
| WMS_URL / WMS_COMPANY_ID | 고정된 시험 대상 origin과 회사 |
| WMS_SOURCE_KEY | integration, `integration:event,integration:read` |
| WMS_PROCESS_KEY | 별도 integration, `integration:process` |
| WMS_WORKER_KEY | automation worker, `read,write` |
| WMS_WORKER_KEYS | 선택, 서로 다른1~10개 automation worker key를 쉼표로구분. UI작업자수에따라고정순환배정 |
| WMS_APPROVER_KEY | 다른 automation supervisor, `read,approve` |
| WMS_SUPERVISOR_KEY | 선택, 역할/인계 시험 전용의 별도 automation supervisor, `read,write,approve` |
| WMS_PREPARE_KEY | 선택, 별도 `master.write` 준비키 |
| SIM_DATABASE | 독립 SQLite 경로, 기본 `data/simulator.sqlite` |
| SIM_HOST / SIM_PORT | 기본127.0.0.1:4310 |
| SIM_UI_TOKEN | 원격 배포시24자 이상 필수. HttpOnly/SameSite cookie 사용 |
| SIM_PUBLIC_ORIGIN | 원격 HTTPS console origin/host 검증 |

`Dockerfile`은 별도 앱 이미지를 만든다. `/app/data`에 영속 볼륨을 연결하고 secret은 runtime binding으로 주입한다. WMS의 Docker/DB와 공유하지 않는다. 원격 서버는 HTTPS reverse proxy를 앞에 둔다. Docker 이미지의 실제 배포/복원 검증은 아직 하지 않았다.

UI에서 연결을 확인하고 창고·전용 시험품목·유형별 위치를 선택한다. 기존 stock/ledger/업무 참조가 없는 품목만 시작한다. 준비키가 있으면 코드/이름 입력으로 정식 기준정보 API에 새 시험 품목을 만든다. 실사 시나리오는 다른 품목 재고도 없는 전용 보관 위치를 요구한다. 과거 실행을 삭제하는 초기화 기능은 없다.

시나리오에는 부분 수령/검수/적치, 과납 승인·반려, 주문80 두건 동시 전체예약, 분할 포장/부분출하, 포장후 취소/출하차단/실물반납, 파손격리/대체피킹, 오스캔 무효과, 실사재계수/다른승인자, 배송실패/반품3수령/2마감, revision3→1→2, 반복 실물입고, seed 기반 거래처 공급이 있다. 수락 시나리오 수량은 고정이며 패턴 공급/반복입고는 seed·사건수·정수 수량분포를 사용한다. seed 재생은 입력 순서와 수량을 재현한다. 동시예약 승자는 고정하지 않고 1건80확보/1건부족이라는 허용 결과 집합을 판정한다.

사람 모드는 외부 공급만 자동으로 보내고 실물 단계마다 멈춘다. WMS에서 표시된 실물 의도를 처리한 뒤 실제 작업자·WMS 요청 ID를 연결하면 독립 수량과 결과를 대조한 후 다음 단계를 연다. 혼합은 정상 작업을 자동 처리하고 책임자/승인 단계를 사람에게 넘긴다. 자동 승인자는 작업자와 다른 key다. 자동 계정의 모든 실물 명령에는 `execution_mode:automated`가 명시된다. WMS의 시험계정/스캔/권한 검증을 우회하지 않는다.

발송 전에 사건과 최종 명령·키를 SQLite FULL/WAL로 기록한다. 결과 미확인은 먼저 원요청을 폴링한다. timeout/429/503은 같은 키·본문으로 기본5회 재시도하고 지수 지연+jitter 및 Retry-After 이후 시각을 영속화한다. 격리 후 재개에도 키를 바꾸지 않는다. 실행 프로세스가 다시 시작되면 진행중 run을 일시정지로 복구한다. 연결의 URL/회사/환경/source/허용창고 fingerprint가 달라지면 재개를 차단한다.

중복 전송/성공 응답 유실 체크박스와 실제 경과0~120초 모의 transport 단절을 제공한다. 단절·대기 일정도 저장하므로 앱 재시작 후 남은 시각을 유지한다. `Retry-After` 대기 중에는 처리/metadata 요청도 다시 보내지 않는다. 모의 transport fault는 실제 네트워크 장비 단절 시험과 구분한다.

독립 판정기는 WMS 계산 모듈을 import하지 않는다. 로컬의 고정 물리수량·성공한 승인 작업으로 위치별 S/R/P/Q/B 기대값을 계산한다. API 응답은 내부 식별자 바인딩과 승인 결과만 사용한다. 안정된 workflow version에서 전체 ledger API를 `has_more=false`까지 커서 순회해 최신100행 미리보기와 혼동하지 않는다. stock과 ledger가 같은 잘못된 수량을 가진 경우도 기대값 차이로 검출한다. 외부 생성/변경의 원품목 수량·현재 예약·주문 보존식도 별도로 검사한다.

보고서는 실행종료/합격을 구분하고 기대거절/미해결/미실행, run/seed/계약·시나리오 버전, 처리경계, 기대/실제/원장, API 읽기/쓰기 호출·고유사건·작업명령·원장행 수, 클라이언트 지연, 재현조건과 복구/정리 상태를 담는다. 비밀값·쿠키는 저장/출력하지 않는다. 보고서 생성 전 사람 작업도 중지하고 결과 미확인 요청을 해소한다. 초기 재고와 물리 업무를 단순히 DB 삭제로 정리하지 않는다.

검증:

```bash
npm test --prefix apps/simulator
node --env-file-if-exists=.env.local node_modules/vitest/vitest.mjs run --project unit tests/unit/v2-integration.test.ts
node --env-file-if-exists=.env.local node_modules/vitest/vitest.mjs run --project integration tests/integration/v2-integration.test.ts
```

실제 PostgreSQL과 WMS API handler를 통한 자동 시나리오 및 전체105행 원장 대사를 검증한다. 8시간 교대, 5400건 혼잡 목표, 100만행 조회조건, 실제 배포복원, 실기기/실제사람 참여, 5영업일 현장 병행은 이 표적 검사 결과로 대체하지 않는다. 원문 기획의 G3/G4/G5 완료를 주장하지 않는다.

## 두 회사 운영 프로필

`profile-targets.example.json`을 복사해 승인된 시험 식별자와 **환경변수 이름**으로 구성한다. 파일에는 key 값을 넣지 않는다. 정상 크기 프로필은 회사2개, 회사별 독립100SKU·20위치·서로 다른10작업자 key를 검증한다. 회사/창고/연계/처리/감독자/작업자 key는 WMS의 관리자 발급 절차로 준비한다. supervisor는 automation supervisor이며 `read,write,approve`를 가진다.

```bash
node --env-file=/private/simulator-bindings.env profile.mjs targets.json smoke
node --env-file=/private/simulator-bindings.env profile.mjs targets.json congestion
node --env-file=/private/simulator-bindings.env shift-profile.mjs targets.json full
```

혼잡은 두 회사가 같은 측정 시작 시각을 사용한다. 회사당 1건/초10분 → 5건/초5분 → 1건/초10분, 고유2700건씩 총5400건을 25분 실제 시간으로 계획한다. 주문70%·입고예정20%·참조 주문 수정10%이며 초기 실물 재고 공급은 측정 사건수에서 분리한다. 외부 공급과10작업자 파이프라인은 서로 다른 계정으로 동작한다. 실제 접수 시각과 예정 시각의 지각을 공개하며 처리 속도를 낮춰 목표를 채운 경우 통과하지 않는다.

입력 일정과 최종 본문/키는 SQLite에 선기록하고, 자동 수령/검수/적치·예약/피킹/포장/출하 명령도 발송 전 영속화한다. 수락된 외부 revision으로 미예약 주문의 의도가 바뀌면 이전 실패 예약은 `superseded`로 보존하고 새 revision의 명령/키를 만든다. 이미 발송한 요청의 본문을 바꾸지 않는다. 이전 revision의 성공 실적과 재고 효과는 유지한다.

중단 후에는 같은 SQLite와 같은 target/secret bindings로 기존 root run ID를 지정한다.

```bash
node --env-file=/private/simulator-bindings.env profile.mjs targets.json congestion EXISTING_ROOT_RUN_ID
```

보고서에는 회사별 고유 입력·원 API 읽기/쓰기·실물 명령·원장 수, 실제 측정 경과, 지연 p95/표본 수, 최대 전송 지각, 예상 거절·미해결·위치/품목/상태 독립 차이를 포함한다. 전체 원장은 고정 workflow boundary로 순회한다. `smoke`/`shift-smoke`는 작은 실행기의 작동 검사이며 25분/8시간 프로필의 통과로 승격하지 않는다. 8시간 wrapper의 엄격한 판정과 T11 인계 근거는 `shift-profile.mjs`에서 별도로 확인한다.

## T09 실제 프로세스 복구 검사

```bash
node --env-file=/private/simulator-bindings.env t09-resilience.mjs targets.json
```

준비 API로 전용 새 SKU를 생성하고 별도 loopback3022 proxy가 최초 외부 사건에429/Retry-After2초, 503/Retry-After3초, 실제 WMS COMMIT 이후 응답 단절을 순서대로 주입한다. SQLite에 대기/미확인을 저장한 simulator child를 실제 SIGKILL로 두 번 종료하고 같은 저장소로 재개한다. 모든 재전송의 event ID·정확한 본문 해시, 실제 재시도 시각, 원접수 조회, 독립 재고/원장, 미확인0을 검사한다. 다른 프로세스/데이터를 종료하거나 초기화하지 않는다. key 값과 쿠키는 proxy 로그나 보고서에 남기지 않는다.

기본 보고서는 `output/t09/report.json`이며 `resilience_output`으로 별도 경로를 지정할 수 있다. 실제 검증 근거는 저장소의 `docs/v2-t09-resilience-latest.json`에 보존한다. 주입된 HTTP 장애와 실제 장비/호스팅 장애를 구분한다. 60초 단절 시험과 SIGKILL/429/503 시험은 각각 다른 증거로 기록한다.

## 편집 가능한 실물 패턴과 실행 비교

독립 웹 UI의 **설정형 혼합**은 업무수·EA 범위·seed와 부족/파손/오스캔 비율을 영속 계획으로 생성합니다. 부족은 전체예약 실패를 확인하고 보충 입고, 파손은 보류 격리 후 대체 예약·피킹, 오스캔은 무효과 거절 후 정상 피킹을 실행합니다. 고정 AC 시나리오에서는 이 세 비율의 비영(非零) 설정을 거절합니다. 중복·지연·성공응답 유실 비율은 사건별/명령별 선택 결과를 SQLite에 먼저 보존하며 재개해도 바뀌지 않습니다. 지연은 사건에, 응답 유실은 사건과 명령에 적용됩니다.

근무 시작/종료는 `Asia/Seoul` 실제 시각입니다. `00:00`~`24:00`은 종일이며 같은 시작/종료도 종일로 취급합니다. 근무 밖에는 신규 요청을 보류하고 미확인 요청은 계속 조회합니다. `worker_interval_ms`는 명령 확정 후 다음 새 명령의 최소 간격입니다. 설정한 확정 작업수에 도달하면 한 번 중단하며 같은 실행 재개로 진행합니다. `handover_after_ms`에 도달하면 인계 대기로 전환하고 UI에서 작업자와 사유를 선택합니다. 별도 `WMS_SUPERVISOR_KEY`(시험 automation, read/write/approve)로 WMS `task.assign`을 수행해 담당자를 영속 변경한 뒤 선택 작업자가 남은 작업을 수행합니다. 책임자 역할 자체를 시험할 때도 이 별도 키를 사용합니다. 승인 전용키와 분리해야 합니다.

보고서는 선택된 패턴, 실제 중복/지연/응답 유실 수, 중단/인계 증거와 독립 실물/전체원장 대사를 함께 기록합니다. 설정된 중단/인계 시점에 도달하지 않은 실행은 합격하지 않습니다. 웹 UI 실행 비교는 두 저장 실행의 설정·seed·판정·호출수·사건수·명령수·p95·차이수와 기대 재고를 나란히 보여주며 설정이 다르면 이를 표시합니다. p95는 로컬 클라이언트 표본으로, 운영 성능 인증이 아닙니다.
