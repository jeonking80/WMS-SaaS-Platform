# 실물 스캔의 업무 참조 기준 검증

기획 MD-02 / AC-11의 오품목 무효과 규칙을 추가 대조했다. 기존 정규화는 요청의 `item_id`와 전체 전표의 첫 `line_id`를 실제 업무 참조보다 먼저 신뢰했다. 예를 들어 품목 A 입고행을 지정하면서 `item_id=B`와 유효한 B 바코드를 보내면 스캔 검사는 통과하고 엔진은 A 재고를 기록할 수 있었다. 다른 전표의 동일 행 ID나 관계없는 행·lot·예약 참조도 실제 lot/피킹의 스캔 기준을 바꿀 수 있었다.

수정은 실제 명령이 소비하는 참조로 품목과 출발 위치를 결정한다. 상충하는 `item_id`·`scanned_item_id`·바코드는 `WRONG_ITEM_SCAN`으로 거절한다. 수동 검색은 기존 사유와 업무 검사를 유지하며, 품목 힌트를 보내지 않은 정상 수동 입력은 허용한다.

## 15개 실물 명령의 기준

| 명령 | 권위 있는 참조 |
| --- | --- |
| `receipt.receive` | 지정 입고의 행 |
| `receipt.inspect`, `receipt.putaway` | 지정 입고의 lot |
| `return.receive` | 지정 반품의 행 |
| `return.inspect`, `return.putaway` | 지정 반품의 lot |
| `order.pick` | 지정 주문의 예약 |
| `package.create`, `order.return_picked`, `order.damage` | 지정 주문의 피킹 |
| `stock.inspect`, `stock.putaway` | 일반 보류 lot |
| `hold.release` | 엔진과 같은 입고→반품→일반 보류 lot 순서 |
| `stock.move`, `stock.hold` | 명시한 `item_id`와 출발 위치 |

관계없는 참조는 기준을 대체하지 않는다. 목적지 스캔 규칙과 정상 참조의 모드→수동 사유→위치→품목→환산/수량 검사 순서를 유지한다. 참조가 없는 수동 요청은 기존 엔진의 `NOT_FOUND`로 끝난다. 참조가 없고 품목을 위장한 바코드 요청은 기존의 뒤늦은 `NOT_FOUND` 대신 `WRONG_ITEM_SCAN`이 먼저 날 수 있다.

조회는 요청 안에서만 만들며 기존 권한으로 읽은 전체 상태를 사용한다. 인증·회사/창고 범위·잠금·대사·저장 경로를 생략하지 않는다. 스키마와 migration 수21은 변경하지 않았다.

## 실행 근거

2026-10-21 04:34:53.802 UTC 공유 슬롯 해제 후 시험 파일만 먼저 적용했다. 수정 전 커밋 `d5f542c2b0de7b401853676f6b7f817c2985a1f9`의 소스에서 새 PG 검사 **4개 모두 실패**(기존31개 제외)해 잘못된 요청이 거절되지 않는 것을 재현했다. 독립 정적 검토를 받은 동일 소스 패치를 적용한 뒤 fixture 수정 없이 다음 검사를 통과했다.

- 스캔 참조 단위 검사 **7/7**.
- 기존 오류 우선순위 검사를 포함한 전체 수락 PostgreSQL 검사 **35/35**.
- `npm run typecheck`와 `git diff --check` 종료 코드0.

새 PG 검사는 서로 다른 전표의 동일 행 ID, 유효한 다른 품목 바코드·수동 힌트, lot 검수/적치, 이동의 명시 품목, 포장의 관계없는 행/lot/예약, 다른 부모의 lot/피킹, 반품 수령/검수를 검사한다. 거절 전후 영속 상태·객체·헤더·재고·원장·요청 행을 비교하고 정상 흐름의 불변식을 확인했다.

원문 로그는 `/tmp/v2-scan-authority-old-source-pg.log`, `/tmp/v2-scan-authority-unit.log`, `/tmp/v2-scan-authority-fixed-pg.log`, `/tmp/v2-scan-authority-typecheck.log`다. 수정 전 로그 SHA-256은 `461e3dcb0a58b22102a6d6486aa07fad405b8b3fadbccdd865dc9acdf43629af`, 적용 패치 SHA-256은 `44ab0c414849b0bfa7e7bd15b75205b830082352c9d6ba63bb0963df6145ab29`다. 수정 전 소스 파일 해시는 `/tmp/v2-scan-authority-old-source-sha256.txt`에 보존했다.

## Full local regression

Exit code 0: 359 unit, 55 simulator, 215 PostgreSQL and 44 browser tests, typecheck and standalone production build. Build `LukXG34LM9HHGd6cYWiMc`; log `/tmp/wms-v2-scan-authority-full-verify.log`, SHA-256 `b4b8fdf8a5f105eb2ed8da3a9d57bcfd954851190228ba03a6efbbd7645e8581`. This does not qualify G3–G5 or overall completion.
