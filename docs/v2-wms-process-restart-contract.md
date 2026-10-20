# WMS 프로세스 중단·재시작 검증

`apps/simulator/wms-restart-case.mjs`는 HTTP와 로컬 JSON journal만 사용한다. `scripts/v2-wms-restart.mjs` 운영 wrapper는 별도 standalone 서버를 127.0.0.1:3205에 직접 띄우고 자신이 만든 PID에만 SIGKILL을 보낸다. WMS 앱에는 제한된 wms_app 연결을, SIM 자식에는 source/process/worker API 키만 전달한다.

초기 시험 회사·관리자·기계 키와 빈 품목/위치/공급처/고객/배송지는 별도 fixture 준비 단계에서 생성해야 한다. 25분/8시간/성능 측정 회사는 사용하지 않는다. target 파일 구조는 교대 프로필과 같고 첫 target의 첫 품목을 사용한다. target URL은 http://127.0.0.1:3205로 고정한다. 재사용한 재고가 있으면 검증을 거절한다.

```sh
node --env-file=.env.local scripts/v2-wms-restart.mjs /private/runtime-manifest.json /private/dedicated-targets.json /private/api-bindings.env
```

runtime manifest는 `{runtime_directory,build_id}`이며 static/public을 포함한 독립 standalone 사본을 가리킨다. API bindings 파일은 값 출력 없이 읽고 target이 지정한 source/process/worker 환경변수만 SIM에 넘긴다.

실제 검증 순서는 10EA 입고·검수·적치, 주문3EA 외부 접수, 처리 전 accepted 확인, 실제 WMS SIGKILL/exit.signal 관찰, 서버 응답 불능 확인, 같은 DB/빌드 새 PID 기동, 원 사건ID 보존 조회와 처리 재개, 같은 사건 재전송, 같은 예약 request_id 재전송, 피킹·포장·출하다. 최종 기대 수량은 journal의 의도에서 계산한다. 재고7EA/예약0, 원본 주문1건, 예약 원장1행, 전체 원장·재고·예약 대사 차이0이어야 통과한다.

최초 실제 실행 보고서는 `v2-wms-process-restart-latest.json`에 보존한다. BUILD_ID VuDcSWeSgbT_5k8fDYdmc에서 PID131404의 SIGKILL과 새 PID131506을 관찰했다. 같은 소스의 후속 빌드나 제공자 복구·RPO/RTO·실제 단말 검증으로 바꾸어 표기하지 않는다.
