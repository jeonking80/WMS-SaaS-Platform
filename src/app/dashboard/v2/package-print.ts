import type { Order, Package } from "@/server/v2/workflow/types";
import { nameOf, printSheet, time, type Context } from "./common";

type PackagePrintContext = Pick<Context, "company" | "warehouse" | "warehouseCode" | "warehouseName" | "items"> & {
  snapshot: Pick<Context["snapshot"], "version">;
};
const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

export function printPackage(
  c: PackagePrintContext,
  pack: Package,
  order: Order,
  printedAt = new Date().toISOString(),
) {
  // Delivery belongs to this saved package. Never replace missing legacy snapshot
  // fields with the current order or mutable address book during a reprint.
  const saved =
    pack.delivery && typeof pack.delivery === "object" && !Array.isArray(pack.delivery)
      ? (pack.delivery as Record<string, unknown>)
      : {};
  const destination = text(saved.delivery_destination_id) || text(saved.destination_id) || text(saved.id);
  const address =
    [text(saved.address_line1), text(saved.address_line2)].filter(Boolean).join(" ") || text(saved.address);
  printSheet(
    "내부 포장명세",
    `${c.company} · 창고 ${c.warehouseName} (${c.warehouseCode}) · 창고 ID ${c.warehouse} · 출력 시각 ${time(printedAt)} (Asia/Seoul) · 상태 버전 ${c.snapshot.version}`,
    [
      ["포장번호", pack.id, "주문 ID", pack.order_id],
      ["외부주문번호", order.external_id || "미등록", "주문 버전", order.version],
      [
        "포장 생성 시각",
        time(pack.created_at),
        "포장 무게",
        pack.weight_grams === undefined ? "미입력" : `${pack.weight_grams} g`,
      ],
      ["배송지 스냅샷 ID", destination || "미기록", "납품처 ID", text(saved.partner_id) || "미기록"],
      [
        "배송지명",
        text(saved.name) || "미기록",
        "수령인",
        text(saved.recipient_name) || text(saved.recipient) || "미기록",
      ],
      ["우편번호", text(saved.postal_code) || "미기록", "배송주소", address || "미기록"],
      ["연락담당", text(saved.contact_name) || "미기록", "전화", text(saved.phone) || "미기록"],
      ["품목", "수량 EA", "원피킹 ID", "원주문행 ID"],
      ...pack.lines.map((line) => {
        const pick = order.picks.find((candidate) => candidate.id === line.pick_id);
        return [
          pick ? nameOf(c.items, pick.item_id) : "원피킹 연결 확인 필요",
          line.quantity,
          line.pick_id,
          pick?.line_id || "미기록",
        ];
      }),
    ],
  );
}
