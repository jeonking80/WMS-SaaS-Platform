import type { Order, Package, Receipt, Return } from '../workflow/types';

export type StepState = 'todo' | 'done' | 'idle';
export type Step = { key: string; caption: string; count: number; unit: string; state: StepState };
/** Plain-language next action for one business object, shared by the queue and the work screens. */
export type Guide = { stage: string; title: string; detail: string; done: boolean; steps: Step[] };

const sum = <T,>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
const state = (count: number, touched: boolean): StepState => count > 0 ? 'todo' : touched ? 'done' : 'idle';

export function receiptGuide(object: Receipt | Return): Guide {
  const lines = object.lines as Receipt['lines'], lots = object.lots;
  const remaining = sum(lines, line => Math.max(0, line.quantity - line.received - line.cancelled));
  const received = sum(lines, line => line.received), pending = sum(lots, lot => lot.pending), normal = sum(lots, lot => lot.normal);
  const hold = sum(lots, lot => lot.hold), putaway = sum(lots, lot => lot.putaway);
  const steps: Step[] = [
    { key: 'receive', caption: '1 수령', count: remaining, unit: 'EA', state: state(object.closed ? 0 : remaining, received > 0) },
    { key: 'inspect', caption: '2 검수', count: pending, unit: 'EA', state: state(pending, lots.length > 0) },
    { key: 'putaway', caption: '3 적치', count: normal, unit: 'EA', state: state(normal, putaway > 0) },
  ];
  if (pending > 0) return { stage: 'inspect', title: `검수할 수량 ${pending} EA`, detail: '수령한 물품의 상태를 확인하고 정상 또는 보류·파손으로 판정하세요.', done: false, steps };
  if (normal > 0) return { stage: 'putaway', title: `적치할 수량 ${normal} EA`, detail: '정상 판정한 물품을 보관 위치에 넣고 위치·품목을 스캔해 확정하세요.', done: false, steps };
  if (remaining > 0 && !object.closed) return received > 0
    ? { stage: 'receive', title: `아직 도착하지 않은 수량 ${remaining} EA`, detail: '나머지가 도착하면 이어서 수령하세요. 더 오지 않는다면 과납·잔량·보류에서 잔량 마감을 요청합니다.', done: false, steps }
    : { stage: 'receive', title: `수령할 수량 ${remaining} EA`, detail: '물품이 도착하면 수령 위치 바코드와 품목 바코드를 차례로 스캔하고 실제 수량을 확정하세요.', done: false, steps };
  if (hold > 0) return { stage: 'exception', title: `보류 중인 수량 ${hold} EA`, detail: '과납·잔량·보류에서 승인 요청 또는 보류 해제를 처리하세요.', done: false, steps };
  return { stage: 'putaway', title: '처리 완료', detail: '수령·검수·적치할 수량이 남아 있지 않습니다.', done: true, steps };
}

export function orderGuide(order: Order, packages: Package[]): Guide {
  const remaining = sum(order.lines, line => Math.max(0, line.quantity - line.shipped - line.cancelled));
  const reserved = sum(order.reservations, row => row.quantity);
  const unreserved = sum(order.lines, line => Math.max(0, line.quantity - line.shipped - line.cancelled - sum(order.reservations.filter(row => row.line_id === line.id), row => row.quantity) - sum(order.picks.filter(row => row.line_id === line.id), row => row.active)));
  const packable = sum(order.picks, row => Math.max(0, row.active - row.packed - row.cancel_pending));
  const ready = packages.filter(row => row.order_id === order.id && row.status === 'complete');
  const shipped = sum(order.lines, line => line.shipped);
  const steps: Step[] = [
    { key: 'reserve', caption: '1 예약', count: unreserved, unit: 'EA', state: state(unreserved, order.reservations.length > 0 || order.picks.length > 0) },
    { key: 'pick', caption: '2 피킹', count: reserved, unit: 'EA', state: state(reserved, order.picks.length > 0) },
    { key: 'pack', caption: '3 포장', count: packable, unit: 'EA', state: state(packable, packages.some(row => row.order_id === order.id)) },
    { key: 'ship', caption: '4 인계·배송', count: ready.length, unit: '포장', state: state(ready.length, shipped > 0) },
  ];
  if (ready.length) return { stage: 'ship', title: `출하할 포장 ${ready.length}개`, detail: '운송사에 넘긴 포장을 선택하고 운송수단·인계자를 입력해 출하를 확정하세요.', done: false, steps };
  if (packable > 0) return { stage: 'pack', title: `포장할 수량 ${packable} EA`, detail: '피킹한 물품을 대기 위치에서 확인하고 품목을 스캔해 포장을 완료하세요.', done: false, steps };
  if (reserved > 0) return { stage: 'pick', title: `피킹할 수량 ${reserved} EA`, detail: '예약된 보관 위치에서 물품을 꺼내 포장 대기 위치로 옮기고 위치·품목을 스캔하세요.', done: false, steps };
  if (unreserved > 0) return { stage: 'reserve', title: `예약할 수량 ${unreserved} EA`, detail: '출고할 재고를 먼저 확보하세요. 가용재고가 부족하면 가능 수량만 예약하고 나머지는 대기로 남깁니다.', done: false, steps };
  if (remaining > 0) return { stage: 'exception', title: `확인이 필요한 수량 ${remaining} EA`, detail: '취소 대기 또는 반납 확인이 남아 있습니다. 취소·파손·대체에서 처리하세요.', done: false, steps };
  return { stage: 'ship', title: '처리 완료', detail: '출하하거나 취소할 수량이 남아 있지 않습니다.', done: true, steps };
}
