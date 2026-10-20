# 8시간 업무 프로필 실행 계약

`apps/simulator/shift-profile.mjs`는 `profile.mjs`의 HTTP 실행과 시뮬레이터 전용 SQLite journal을 함께 검증한다. WMS 데이터베이스에 연결하지 않는다. 초기 시험 회사 fixture 준비와 앱 서버의 DB 연결은 별도 준비 단계다.

- `full`: 서로 다른 시험 회사 2개, 회사별 1창고·100품목·20위치·10자동 작업자, 실제 8시간, 회사별 주문 1,000건·입고예정 100건을 요구한다. 주문당 1~5품목을 사용한다.
- `smoke`: 축소 회사·품목·작업자와 짧은 시간을 명시한다. 결과는 `smoke_passed`이며 `eight_hour_requirement_passed`는 항상 false다.
- 처음 생성한 빈 품목은 측정 전 입고예정→수령→검수→적치로 초기재고를 만든다. 이 입고는 측정 처리량에 포함하지 않는다.
- 누적 원장 fixture를 재사용하려면 각 target에 `baseline: {source_run_id, expected_positions:[{item_id,location_id,S,R,P,Q,B}]}`를 지정한다. 수량은 독립 fixture generator manifest에서 가져온다. 측정 전 실제 stock 및 전체 cursor 원장을 이 값과 대사하고, 측정 후에는 이 초기값에 로컬 작업 의도 delta를 더해 다시 대사한다. 이 경우 초기 입고는 생성하지 않는다.

T11은 첫 주문을 supervisor가 실제 자동 작업자에게 배정하고 예약 이후 피킹을 보류한다. full에서는 실제 예약 나이 2시간 이상을 관찰하고 시작 4시간 이후 교대한다. 새 작업 전송을 멈추고 진행 중 명령이 끝나기를 기다린 뒤, 불확실한 요청은 원래 request_id로 결과를 조회한다. 미확인 결과나 격리 명령이 남으면 교대를 허용하지 않는다. `shift.close`에 모든 미완료 업무의 새 담당자를 보내고, 응답 후 담당자 이력과 재고 불변을 재확인한다. 남은 피킹·포장·출하는 최신 담당자 키로 진행한다. 이 2시간 관찰은 시험 프로필 조건이며 기본 운영의 24시간 경보를 발생시켰다는 의미가 아니다.

명령 본문·request_id는 journal에 먼저 저장하고 재시도에도 보존한다. 인계로 담당 키가 바뀌더라도 원 결과 조회가 먼저이며 본문은 바꾸지 않는다. 원본 입력의 객체 식별자·품목·수량·수령/출고량, 예약잔량, 재고, 전체 원장과 물리 단계 완료 수를 별도로 검증한다. 같은 stock/ledger 오류가 있어도 로컬 의도와 다르면 실패한다.

비밀값은 target 파일에 넣지 않고 `source_key_env`, `process_key_env`, `supervisor_key_env`, `worker_key_envs`가 지정한 환경변수로 전달한다. 자식 HTTP 런타임에는 이 키들과 제한된 실행 환경만 상속하며 DB URL·관리자 암호·provider 비밀을 전달하지 않는다.

```sh
node --env-file=/private/bindings.env apps/simulator/shift-profile.mjs /private/targets.json full
node --env-file=/private/bindings.env apps/simulator/shift-profile.mjs /private/targets.json full SAVED_RUN_UUID
```

성능 측정과 8시간 쓰기는 같은 회사에서 동시에 실행하지 않는다. 누적 100만 원장 읽기 측정이 끝난 뒤 해당 시험 DB를 순차 재사용한다. 서버는 최종 standalone 빌드와 static/public을 별도 디렉터리로 복사해 실행한다. 개발 체크아웃의 후속 빌드가 그 서버 파일을 바꾸지 않도록 한다.

외부 송신과 queue processor는 회사별 독립 tick으로 실행하여 누적 재고 snapshot의 긴 읽기가 예정 송신을 막지 않게 한다. full 판정은 정합성과 별도로 확정 p95 1.5초, 외부 접수 p95 1초, 업무 반영 p95 5초, 정상부하 기술 실패율 0.1% 미만 및 종료 후 10분 회복을 요구한다. `integrity_passed`, `functional_passed`, `quality_targets`를 분리한다. 지연은 요청 시작부터 응답 본문 전체 수신과 JSON 해석 완료까지 측정한다. 정상 측정 시간창의 분모·샘플을 공개하고 초기 baseline/seed 및 최종 대사용 읽기는 그 시간창에서 제외한다. HTTP 확정 지연으로 실제 스캐너 성능을 인증하지 않는다.

현재 검증: 시뮬레이터 단위 18개 통과(T11 controller와 초기 baseline 오염 검출 포함). 새 T11 HTTP 축소 smoke(2회사·2품목·2worker/회사, 실제 20초, 회사별 주문4/입고2)도 통과했다. 실시간 예약나이 관찰·새 담당자 교대·인계 이후 실물 완료 및 독립 대사 차이0을 기록했다. docs/v2-shift-smoke-latest.json와 v2-shift-smoke-environment.json을 함께 확인한다. 이 결과는 실제 8시간 완료를 대신하지 않는다. 실제 실행 결과가 생기기 전에는 8시간, 호스팅, 실제 단말 및 현장 G4/G5를 완료로 표시하지 않는다.
