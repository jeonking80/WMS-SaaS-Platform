# WMS v2 workflow contract

업무 API: `GET /api/v2/workflow?warehouse_id=UUID` → `{snapshot}`. `POST /api/v2/workflow` body `{warehouse_id,command,request_id,payload}` → `{result,snapshot,replayed}`. request_id는 클라이언트가 생성한 UUID, 같은 키/다른 본문은409. GET `request_id`를 주면 해당 결과 조회. 모든 수량 정수EA. 1명령 실제 명세 최대20, 예정/주문 최대100행.

서비스: `executeWorkflow(identity, {warehouse_id,command,request_id,payload})`; `executeWorkflowInTransaction(client, identity, input)`는 이미 withTenant/권한검사를 수행한 외부 사건 어댑터용이며 별도 COMMIT 없음. `getWorkflowSnapshot(identity,warehouseId)`.

`Snapshot`: `{version,stock,receipts,orders,packages,shipments,returns,approvals,counts,tasks,shifts,ledger,reconciliation}`. stock행 `{item_id,location_id,S,R,P,Q,B,A,H,locked}`. 업무 객체 id는 서버 UUID; 원행은 `{id,item_id,quantity,...}`. create결과 `result={id,...}`. 처리명령 payload 공통 `lines:[...]`, `reason`, `expected_version`(선택). 실제실적 lines는 최대20. 모든 조회는 회사/창고 권한 적용.

|command|payload|
|---|---|
|receipt.create|external_id?, supplier_id, expected_at, lines:[{id?,item_id,quantity}]|
|receipt.update|receipt_id,lines:[{id,item_id,quantity}]|
|receipt.receive|receipt_id,lines:[{line_id,quantity,location_id}]|
|receipt.inspect|receipt_id,lines:[{lot_id,quantity,outcome:'normal'/'hold'}]|
|receipt.putaway|receipt_id,lines:[{lot_id,quantity,location_id}]|
|receipt.cancel|receipt_id,reason|
|receipt.close.request|receipt_id,reason|
|overage.request|lot_id,quantity,reason|
|approval.decide|approval_id,approve:boolean,reason|
|hold.release|lot_id,quantity,location_id,reason|
|order.create|external_id?,delivery:{partner_id,delivery_destination_id},due_at,original_order_id?,original_return_id?,lines:[{id?,item_id,quantity}]|
|order.update|order_id,delivery?,lines:[{id,item_id,quantity}]|
|order.reserve|order_id,partial:boolean,lines?:[{line_id,quantity,location_id}] (명세없으면 자동위치선정 전체잔량)|
|order.release|order_id,lines:[{reservation_id,quantity}]|
|order.pick|order_id,lines:[{reservation_id,quantity,location_id,scanned_item_id?,scanned_location_id?}]|
|order.cancel|order_id,lines:[{line_id,quantity}],reason|
|order.return_picked|order_id,lines:[{pick_id,quantity,location_id,outcome:'normal'/'hold'}],reason|
|order.damage|order_id,lines:[{pick_id,quantity,location_id}],reason (책임자)|
|package.create|order_id,lines:[{pick_id,quantity}],delivery?,weight_grams?:positive integer g|
|package.unpack|package_id,reason|
|shipment.create|package_ids:UUID[],handover_by,carrier,handed_over_at?|
|shipment.delivery|shipment_id,status:'in_transit'/'delivered'/'failed'/'lost',revision,reason?|
|shipment.delivery.correct|shipment_id,previous_revision,revision,status,reason (책임자)|
|return.request|shipment_id,lines:[{shipment_line_id,quantity}],reason|
|return.receive|return_id,lines:[{line_id,quantity,location_id}]|
|return.close|return_id,reason|
|return.inspect|return_id,lines:[{lot_id,quantity,outcome}]|
|return.putaway|return_id,lines:[{lot_id,quantity,location_id}]|
|stock.move|lines:[{item_id,from_location_id,location_id,quantity}],reason|
|stock.hold|lines:[{item_id,from_location_id,location_id,quantity}],reason|
|count.start|location_id|
|count.record|count_id,lines:[{item_id,bucket:'S'/'Q'/'B',quantity}],recount:boolean,reason|
|count.submit|count_id,reason|
|count.unlock|count_id,reason (책임자)|
|task.assign|object_type,object_id,assignee_id,reason|
|shift.close|handover:[{object_type,object_id,assignee_id,reason}],unconfirmed_request_ids:[]|
|correction.request|lines:[{item_id,location_id,bucket:'S'/'Q'/'B',quantity: signed integer}],reason,original_id|

포장명세는 원피킹 id별 구분, 최대20. 출하는 전체완료포장 선택만, 선택포장명세 합계20이하. 파손격리는 포장해제 후 P→B와유효피킹점유해소 원자처리. 취소대기피킹은 포장/출하금지. 반품 원출하행에 누적수령+유효승인미수령 <=출하량. 실사위치 잠금/승인 버전/자기승인금지. 과납은 B로 수령 후 다른승인자 승인→hold.release→inspect→putaway.

PG migration `1792368000010_v2-workflow.sql`: `v2_workflow_state`(회사/창고별 JSONB 업무aggregate, row lock), `v2_workflow_stock`(회사/창고/품목/위치별 S/R/P/Q/B), `v2_workflow_ledger`(불변 delta,request/actor/original), `v2_workflow_requests`(본문hash+원결과). 전테이블 FORCE RLS, stock의 회사/창고/위치/품목 복합FK. 창고행 잠금으로 예약/실사/출하/취소 등 모든 경쟁을 직렬화하고 동일트랜잭션에 업무/재고/원장/멱등응답 확정.

추가: receipt.receive/return.receive payload `receiving_id:UUID`는 동일 실물수령건 식별자이며 새 request_id로 재요청해도 중복확정 금지. 미지정시 request_id 사용(클라이언트는 반드시 별도실물식별자를 유지). 상세응답 타입은 src/server/v2/workflow/types.ts. 내부전환 전용 `importLegacyOpeningInTransaction(client,identity,warehouseId,rows,requestId)` 공개명령이 아니며 구원장 개시상태 이관.

성능/재요청: 원요청 저장소는 불변 `{result,version}`만 저장한다. 재요청은 같은 원result와 현재snapshot을 반환한다. snapshot.ledger는 최근100개 미리보기이며 전체불변이력은 v2_workflow_ledger에 영속한다. 업무state에는 전체원장을 중복저장하지 않는다. 조회·교대마감은 PG실제원장합계를 정규재고와 독립대사한다. snapshot.stock.A는 위치kind/활성/예약차단 및 실사잠금을 모두 반영한다. stock.hold는 result.lot_ids를 생성하며 snapshot.holds에서 추적한다. 일반보류 해제→stock.inspect→stock.putaway는 lot_id 명세로 처리한다.

추가 명령 `order.shortage`: `{order_id,lines:[{reservation_id,quantity}],reason}`. 예약해제와 위치의 점검용 예약차단을 함께 반영하며 S/H는 차감하지 않는다. `snapshot.location_blocks`로 사유를 표시하고 위치실사 승인시 해당 차단을 해제한다. 새 예약은 차단위치를 제외한다. 명시적 예약위치도 같은 검사 적용.

모든 barcode모드 실적은 `lines[].scans:[{barcode,count}]`를 보내고 서버가 불변 master_barcodes 환산을 다시 조회한다. quantity가 계산값과 다르면 거절한다. 검색대체모드 `input_mode:'search'`는 최상위 manual_entry_reason 필수. hold.release는 동일필드를 top-level로 받는다. `v2_workflow_performances`에는 요청원문이 아닌 품목/위치/수량/입력단위/환산/기준수량 증거만 불변저장한다. 실물수령 식별자는 `v2_workflow_receivings` 회사전체고유, 외부번호는 `v2_workflow_objects` 회사/업무종류별고유.

전체 원장조회: `GET /api/v2/workflow/ledger?warehouse_id=UUID&item_id=UUID(선택)&location_id=UUID(선택)&limit=100(최대500)&cursor=...(선택)&boundary=업무version(선택)&from=ISO(선택)&to=ISO(선택)` → `{rows,cursor,has_more,boundary,warehouse_id,item_id,location_id,from,to}`. 각 row는 id/item_id/location_id/bucket/delta/request_id/actor_id/command/reason/original_id/created_at/version. 처음페이지가 현재 업무version을 boundary로 고정하며 다음페이지도 같은커서·필터로 조회한다. 해당버전 이후실적은 제외하므로 페이지 도중 신규업무가 생겨도 누락/중복없이 고정집합을 조회한다. 시뮬레이터는 snapshot.version을 boundary에 지정해같은처리경계를 대사한다. 전체조회는 has_more=false까지 cursor반복. `format=csv`는 동일한bounded페이지의 CSV를 반환하고 X-Ledger-Boundary/X-Ledger-Has-More/X-Ledger-Cursor 헤더를 제공한다. 셀 수식주입은 작은따옴표로 차단한다. 스키마추가없음.

권한보강: 부분수령예정의 receipt.cancel은 CLOSE_APPROVAL_REQUIRED로 거절하며 receipt.close.request→다른승인권자 approval.decide로잔량을마감한다. 미수령예정만직접취소가능. task.assign은 책임자가배정하고 작업자는현재본인담당업무만다른작업자에게인계가능하다. 포장해제/출하도원주문담당자를역추적한다. shift.close는책임자만실행하며인계보고서와새담당이력을함께확정한다.

실물명령에서 human은 input_mode를생략할수없다. 자동실행은 시험회사/test환경의 automation 기계계정이 payload.execution_mode='automated'를명시해야허용하며 일반계정의모드위조는거절한다. barcode/search실물대조조건은위와같다. original_order_id/original_return_id로추가주문·재배송의원본연결을보존한다. 위치실사는20명세씩여러 count.record로누적하며제출시위치전체필수계수완료와차이행재계수를확인한다.

운영/시험 입력 정책: 생산 창고의 실물 작업은 사람 세션으로 수행하며 등록바코드 스캔 또는 사유를 남긴 검색 대조를 요구한다. 생산 연계 계정은 입고예정/주문/배송/반품요청 같은 외부 사건 공급용이며 수령·피킹·조정 등 실물 쓰기를 할 수 없다. 자동 작업 계정은 기획6·10·14장에 따라 시험회사와 test환경에서만 발급·사용한다. `execution_mode:'automated'`는 이 시험용 automation 계정만 사용할 수 있고 생산 연계키/일반 사람계정은 같은 필드를 보내도 거절한다. 자동 실행도 품목·위치·잔량·권한·승인분리·재고불변식은 동일하게 검증한다. 단위/오스캔 검증 시나리오는 자동모드에서도 barcode와 scan count 증거를 보내 실제 서버 환산검사를 거친다.

필수 등록정보: receipt.create는 supplier_id와 expected_at(ISO), order.create는 delivery.partner_id와 delivery.delivery_destination_id 및 due_at(ISO)를 요구한다. 공급/납품처 역할·활성상태·배송지의 납품처 연결을 확인하며 서버 DB의 실제 배송지로 스냅샷을 구성한다.

정정통제: correction.request.original_id는 필수이며 실존하는 같은 회사·창고의 v2원장 또는 기존 stock_ledger/기존전표를 지정한다. 원품목·위치·상태에 대한 반대 부호만, 누적보상은 원수량까지만 허용한다. 이동/상태전환의 양쪽 명세는 함께 보상한다. 원본 이후 예약/피킹/이동 등 후속효과가 있으면 선행해소 또는 별도 반품/실사를 요구하고 직접보상을 거절한다. 기존전표는 확인된 v2_cutovers.opening의 출발위치→새위치·S/Q/B 매핑 안에서만 보상하며 구전표·구원장은 변경하지 않는다. 매핑이 없거나 품질이 불명확하면 위치실사를 사용한다. 이미 보상된 정정원장을 다시 원본으로 삼아 한도를 우회할 수 없다.

원본검색: GET /api/v2/workflow/correction-source?warehouse_id 는 {sources:[{id,kind:'legacy',document_no,document_number,document_kind,created_at}],next_cursor,has_more} 형태로 기존확정전표를 조회한다. q는 전표번호·WMS 표시번호·품목 코드/명·메모를 검색하며 100자까지 허용하고 %/_는 검색 문자 그대로 처리한다. item_id로 원전표의 품목을 좁히며 limit은 1~100, 기본50이다. next_cursor를 cursor로 보내면 확정시각·UUID 기준의 다음 과거 페이지를 읽는다. 커서는 회사·창고·q·item_id와 결합되며 필터나 범위를 바꿔 재사용하면 INVALID_CURSOR로 거절한다. 화면의 기존 전표 검색과 50개 추가 조회로 첫50개 이전 원본도 선택할 수 있고 품목 필터는 기존전표와 v2원장 모두 적용된다. original_id를 추가하면 기존과 같은 {source,lines:[{item_id,location_id,bucket,quantity}],blocked_reason}로 원본에 대응하는 잔여 보상 명세와 거절 사유를 조회한다. v2원장은 기존 전체원장커서검색의 id를 사용한다. 기존원장 id는 같은 원전표 id로 정규화하여 중복보상 키를 보존한다.

요청지표: api_request_metrics는 승인된 회사·창고의 처리결과만 별도 트랜잭션으로 저장한다. 요청원문/쿠키/주소/이름/토큰은 저장하지 않으며 서버요청UUID·내부주체ID·정적API명/명령·HTTP상태·허용오류코드·처리시간만 보존한다. 재고 트랜잭션이 롤백돼도 거절/오스캔 지표는 남고, 지표저장 자체가 실패해도 기존 API 응답은 유지한다. 인증·창고접근에 실패해 승인범위가 없는 요청은 회사 지표에 섞지 않는다. duration_ms는 업무처리 완료까지의 서버 처리시간이며 지표쓰기 시간을 제외한다.

자동 작업 인계: assignee_id='machine:<key UUID>'는 test 서버·시험회사에서만 허용한다. 대상은 현재 활성 automation/test 키이며 같은 창고·read/write 범위·미회수·미만료·worker/supervisor 역할을 모두 다시 확인한다. 일반 사람/기계 작업자 모두 현재 담당자 조건을 동일하게 적용한다. 작업자는 본인 담당만 인계하고 책임자가 최초 배정한다. 인계는 진행 중 업무와 같은 창고 잠금으로 직렬화되므로 이전 작업의 완료 뒤 새 담당이 반영되고 이후 구담당 요청은 차단된다. 자동 실행기는 먼저 pause하여 in-flight 요청을 정리하고 원키 결과를 확인한 뒤 task.assign을 호출한다. 선택 필드 unconfirmed_request_ids를 주면 빈 배열만 허용한다. 미해소 결과를 숨기며 인계할 수 없다. identityContext.automationAccounts는 시험회사/test 환경의 허용 창고를 공유하는 활성 후보만 노출한다.

실제 API 수락 프로필: apps/simulator/scenarios-acceptance.mjs는 runAcceptance({api,connection,config,store,scenario,peerApi?,peerConnection?,peerConfig?,revokeKey?,revokedApi?})를 export한다. 자체 SQLite 저장소에 명령·요청키·독립 기대 delta를 먼저 저장하고, 정식 외부 접수/처리 API와 업무 API만 사용한다. CLI `node --env-file=<비밀 env 경로> apps/simulator/scenarios-acceptance.mjs <비밀 없는 targets.json> T03|T04|T10 [resume-run-id]`. T03은 21원행 동일SKU의 20+1/12+9 포장과 21명세 무효과 거절, T04는 미예약/예약/피킹/포장/인계 이후 취소, T10은 동일코드 회사 격리·회사 내 창고제한·실제 키회수 다음요청 차단을 수행한다. 기존 부하용 catalog는 사용하지 않고 준비 API로 전용 시험 SKU를 추가한다. T10의 관리자 로그인/일회키 발급·회수는 명시된 시험 운영 계정의 정식 API로만 실행하며 인증 비밀을 결과/SQLite에 보관하지 않는다.

최종 보강 계약: 승인에는 실제 요청자 requester_id/request_id/requested_at과 승인 대상 실적자 origin_actor_ids를 따로 보존한다. 과납은 원수령자, 실사는 모든 count.record 계수자(counter_ids) 및 제출자(submitted_by), 정정은 원실적자를 요청자와 별도로 확인하며 이들 모두 자기 승인을 할 수 없다. 과거 aggregate의 분리 필드가 없더라도 불변 요청/실적/원장 이력에서 다시 복원한다.

package.create의 선택 weight_grams는 1~1,000,000,000 정수 g이다. 배송 정정 전용 shipment.delivery.correct는 책임자 권한으로 {shipment_id,previous_revision,revision:previous_revision+1,status,reason}를 받는다. 현재 revision 불일치·빈 사유는 거절하고 이전 상태/revision, 새 상태/revision, operation:'correction',actor_id,request_id,at를 사건 이력에 보존한다. 일반 shipment.delivery는 operation:'record'이며 delivered/lost 이후 일반 기록은 거절한다. 두 경로 모두 재고·원장 효과가 없다.

order.update.delivery는 미포장 잔량의 새 기본 배송지를 바꾸며 이미 완료/출하된 포장과 출하의 배송지 스냅샷은 보존한다. 기존 포장 주소를 바꾸려면 포장 해제 후 다시 포장한다. order.damage와 order.return_picked outcome:'hold'는 snapshot.holds의 추적 lot 및 result.lot_ids를 생성하므로 일반보류 해제→stock.inspect→stock.putaway 경로를 따른다. receipt/return 품질보류는 원 lot으로 hold.release 후 해당 receipt/return inspect/putaway를 사용한다. 원장 조회/CSV는 선택 location_id 필터를 지원하며 커서와 함께 동일 필터를 유지해야 한다.

추가 실제 API 수락 시나리오: 같은 CLI/모듈은 T01/T02/T05/T06/T07/T08도 지원한다. 각 실행은 PREPARE API로 신규 품목과 RECEIVING/STORAGE 2개/STAGING/HOLD 위치를 만들고, 시나리오별 required_checks를 모두 통과해야 not_executed=[]가 된다. T02는 동시 HTTP 예약의 허용 승자와 부족 잔량을 확인하고 재입고 후 명시 재예약하며, T06은 위치 차단·실사 승인·파손 대체까지 연속 실행한다. T07의 응답 유실은 실제 확정 HTTP 응답을 클라이언트에서 버린 뒤 원키 조회하는 주입이며 선로 장애로 부르지 않는다. T08은 의존성대기·업무거절·내용충돌을 실제 사건 결과로 구분하고 새 revision으로 복구한다. 독립 판정은 계획한 수량 delta와 같은 version 경계의 실제 재고/전체 원장을 대조한다. [실행 요약](v2-operational-acceptance-latest.json)에 최종6개 신규 실행의 개별 보고서·runner·server bundle 해시와35개 필수 체크를 보존했다.
