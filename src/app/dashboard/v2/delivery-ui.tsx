"use client";
import { useState } from "react";
import type { Shipment } from "@/server/v2/workflow/types";
import { Field, Note, Submit, time, type Context } from "./common";

const statuses = [
  ["handed_over", "인계 완료"],
  ["in_transit", "운송 중"],
  ["delivered", "배송 완료"],
  ["failed", "배송 실패"],
  ["lost", "분실"],
];
const statusName = (status: string) => statuses.find(([code]) => code === status)?.[1] || status;
type DeliveryEvent = Shipment["events"][number] & {
  operation?: string;
  previous_revision?: number;
  previous_status?: string;
  actor_id?: string;
  request_id?: string;
};

export function Delivery({ c, shipment, index }: { c: Context; shipment: Shipment; index: number }) {
  const [nextStatus, setNextStatus] = useState("in_transit"),
    [eventReason, setEventReason] = useState(""),
    [correcting, setCorrecting] = useState(false),
    [correctedStatus, setCorrectedStatus] = useState(""),
    [correctionReason, setCorrectionReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [confirmedRevision, setConfirmedRevision] = useState<number | null>(null);
  const manager = ["admin", "supervisor"].includes(c.role),
    terminal = ["delivered", "lost"].includes(shipment.status);
  const packages = c.snapshot.packages.filter((pack) => shipment.package_ids.includes(pack.id));
  return (
    <section className="v2-card">
      <h3>
        출하 {index + 1} · {statusName(shipment.status)}
      </h3>
      <div className="v2-badges">
        {packages.map((pack, packIndex) => (
          <span className="v2-badge" key={pack.id}>
            포장 {packIndex + 1} · {pack.lines.length}명세 · 무게{" "}
            {pack.weight_grams === undefined ? "미입력" : `${pack.weight_grams} g`}
          </span>
        ))}
      </div>
      <Note>
        현재 배송 이력 {shipment.revision}차 · 인계 {time(shipment.handed_over_at)}. 배송 사건과 정정은 창고 재고를
        변경하지 않습니다.
      </Note>
      {c.role !== "viewer" && !terminal && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void c
              .run("shipment.delivery", {
                shipment_id: shipment.id,
                status: nextStatus,
                revision: shipment.revision + 1,
                reason: eventReason,
              })
              .then((result) => {
                if (result) setEventReason("");
              });
          }}
        >
          <Field label={`출하 ${index + 1} 배송 상태`}>
            <select value={nextStatus} onChange={(e) => setNextStatus(e.target.value)}>
              {statuses
                .filter(([code]) => code !== "handed_over")
                .map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={`출하 ${index + 1} 배송 사건 사유`}>
            <input
              value={eventReason}
              onChange={(e) => setEventReason(e.target.value)}
              required={shipment.status === "failed" && nextStatus === "in_transit"}
            />
          </Field>
          <Submit disabled={c.busy}>배송 사건 기록</Submit>
        </form>
      )}
      {terminal && (
        <Note>배송 완료·분실은 일반 사건으로 되돌릴 수 없습니다. 기록 오류는 책임자의 명시적 정정으로 처리합니다.</Note>
      )}
      {manager && (
        <>
          <button
            type="button"
            onClick={() => {
              setCorrecting((value) => !value);
              setCorrectedStatus("");
              setCorrectionReason("");
              setConfirmed(false);
            }}
          >
            {correcting ? "배송 정정 닫기" : "배송 상태 정정"}
          </button>
          {correcting && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  !confirmed ||
                  confirmedRevision !== shipment.revision ||
                  !correctedStatus ||
                  correctedStatus === shipment.status
                )
                  return;
                void c
                  .run("shipment.delivery.correct", {
                    shipment_id: shipment.id,
                    previous_revision: shipment.revision,
                    revision: shipment.revision + 1,
                    status: correctedStatus,
                    reason: correctionReason,
                  })
                  .then((result) => {
                    if (result) {
                      setCorrecting(false);
                      setCorrectedStatus("");
                      setCorrectionReason("");
                      setConfirmed(false);
                    }
                  });
              }}
            >
              <h3>책임자 배송 상태 정정</h3>
              <Field label={`출하 ${index + 1} 정정할 배송 상태`}>
                <select
                  value={correctedStatus}
                  onChange={(e) => {
                    setCorrectedStatus(e.target.value);
                    setConfirmed(false);
                  }}
                  required
                >
                  <option value="">확인한 실제 상태를 선택하세요</option>
                  {statuses
                    .filter(([code]) => code !== shipment.status)
                    .map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={`출하 ${index + 1} 배송 정정 사유`}>
                <textarea
                  value={correctionReason}
                  onChange={(e) => {
                    setCorrectionReason(e.target.value);
                    setConfirmed(false);
                  }}
                  required
                />
              </Field>
              <div className="v2-alert">
                <p>
                  {statusName(shipment.status)} ({shipment.revision}차) →{" "}
                  {correctedStatus ? statusName(correctedStatus) : "정정할 상태 선택"} ({shipment.revision + 1}차)
                </p>
                <p>
                  기존 배송 이력과 인계·출하 수량을 보존하고 정정 사유·처리자·시각을 새 이력으로 남깁니다. 창고 재고는
                  변하지 않습니다.
                </p>
                <label className="v2-checkbox">
                  <input
                    type="checkbox"
                    checked={confirmed && confirmedRevision === shipment.revision}
                    onChange={(e) => {
                      setConfirmed(e.target.checked);
                      setConfirmedRevision(e.target.checked ? shipment.revision : null);
                    }}
                    required
                  />
                  현재 상태와 실제 배송 상태, 정정 사유를 확인했습니다.
                </label>
              </div>
              <Submit
                disabled={
                  c.busy ||
                  !correctedStatus ||
                  correctedStatus === shipment.status ||
                  !correctionReason.trim() ||
                  !confirmed ||
                  confirmedRevision !== shipment.revision
                }
              >
                배송 상태 정정 확정
              </Submit>
            </form>
          )}
        </>
      )}
      {shipment.events.length > 0 && (
        <details>
          <summary>배송 사건·정정 이력 ({shipment.events.length}건)</summary>
          <div className="v2-table">
            <table>
              <thead>
                <tr>
                  <th>시각</th>
                  <th>구분</th>
                  <th>상태·이력 차수</th>
                  <th>사유·처리자</th>
                </tr>
              </thead>
              <tbody>
                {(shipment.events as DeliveryEvent[]).map((event, eventIndex) => (
                  <tr key={eventIndex}>
                    <td>{time(event.at)}</td>
                    <td>
                      {event.correction === true || event.operation === "correction" ? "명시적 정정" : "배송 사건"}
                    </td>
                    <td>
                      {event.previous_status ? `${statusName(event.previous_status)} → ` : ""}
                      {statusName(event.status)} ·{" "}
                      {event.previous_revision !== undefined ? `${event.previous_revision} → ` : ""}
                      {event.revision}차
                    </td>
                    <td>
                      {event.reason || "사유 없음"}
                      {event.actor_id
                        ? ` · ${event.actor_name || c.people.find((person) => person.userId === event.actor_id)?.name || `이전 처리자 (${event.actor_id})`}`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
