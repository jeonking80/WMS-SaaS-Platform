"use client";
import { useEffect, useState } from "react";
import { OpeningImport } from "./opening-import-ui";
import { api, message, Select, options, Quantity, Note, Submit, type Context } from "./common";
type Balance = {
  item_id: string;
  location_id: string;
  quantity: string;
  item_code: string;
  item_name: string;
  location_code: string;
};
type Preview = {
  rows: Balance[];
  summary: { documents: number; drafts: number };
  consistent: boolean;
  snapshot_hash: string;
  cutover: { activated_at: string } | null;
};
type Mapping = {
  item_id: string;
  source_location_id: string;
  location_id: string;
  bucket: "" | "S" | "Q" | "B";
  quantity: number;
};
export function Cutover({ c }: { c: Context }) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [rows, setRows] = useState<Mapping[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [backup, setBackup] = useState(false),
    [request, setRequest] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setRows([]);
    setConfirmed(false);
    setBackup(false);
    setRequest(null);
    if (c.role !== "admin") return;
    api<Preview>(`/api/v2/operations/cutover?warehouse_id=${c.warehouse}`)
      .then((data) => {
        if (active) {
          setPreview(data);
          setRows(
            data.rows
              .filter((row) => Number(row.quantity) > 0)
              .map((row) => ({
                item_id: row.item_id,
                source_location_id: row.location_id,
                location_id: "",
                bucket: "",
                quantity: Number(row.quantity),
              })),
          );
        }
      })
      .catch((e) => active && setError(message(e)));
    return () => {
      active = false;
    };
  }, [c.warehouse, c.role, c.snapshot.version]);
  if (c.role !== "admin") return <Note>기존 창고 전환은 해당 창고의 회사 관리자가 수행합니다.</Note>;
  function update(index: number, change: Partial<Mapping>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));
    setRequest(null);
    setConfirmed(false);
  }
  async function activate() {
    if (!preview) return;
    setBusy(true);
    setError("");
    const key = request ?? crypto.randomUUID();
    setRequest(key);
    try {
      const result = await api<{ cutover: { activated_at: string } }>("/api/v2/operations/cutover", "POST", {
        warehouse_id: c.warehouse,
        request_id: key,
        snapshot_hash: preview.snapshot_hash,
        confirmed: true,
        rows,
      });
      setPreview({ ...preview, cutover: result.cutover });
      setRequest(null);
      await c.refresh();
    } catch (e) {
      setError(message(e) + " 처리 결과가 불명확하면 같은 입력으로 다시 확인하세요.");
    } finally {
      setBusy(false);
    }
  }
  const remaining = (source: Balance) =>
    Number(source.quantity) -
    rows
      .filter((row) => row.item_id === source.item_id && row.source_location_id === source.location_id)
      .reduce((sum, row) => sum + row.quantity, 0);
  return (
    <>
      <section className="v2-card">
        <h2>기존 창고 운영 전환</h2>
        <Note>
          기존 전표와 원장을 보존하고, 확인한 실물 상태와 위치로 잔량을 이관합니다. 전환 후 기존 입고·출고·이동 확정과
          역분개는 차단되고 현장 운영 화면에서 처리합니다.
        </Note>
        {error && (
          <p role="alert" className="v2-alert">
            {error}
          </p>
        )}
        {!preview ? (
          <p>전환 조건 조회 중…</p>
        ) : preview.cutover ? (
          <p className="v2-success">
            전환됨 · {new Date(preview.cutover.activated_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}. 기존
            전표는 이력으로 보존됩니다.
          </p>
        ) : (
          <>
            <p>
              기존 전표 {preview.summary.documents}건 · 미확정 초안 {preview.summary.drafts}건 · 원장 대사{" "}
              {preview.consistent ? "일치" : "불일치"}
            </p>
            <Note>
              초안은 먼저 취소 또는 마감하고 원장 차이를 해결하세요. 같은 실물을 양쪽 업무 화면에서 동시에 확정하지
              않습니다.
            </Note>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void activate();
              }}
            >
              {rows.map((row, index) => {
                const original = preview.rows.find(
                  (x) => x.item_id === row.item_id && x.location_id === row.source_location_id,
                )!;
                return (
                  <div className="v2-card" key={index}>
                    <h3>
                      {original.item_code} · {original.item_name}
                    </h3>
                    <p>
                      기존 위치 {original.location_code} · 총 {original.quantity} EA · 미배분 {remaining(original)} EA
                    </p>
                    <div className="v2-grid">
                      <label className="v2-field">
                        <span>확인한 실물 상태</span>
                        <select
                          required
                          value={row.bucket}
                          disabled={busy}
                          onChange={(e) =>
                            update(index, { bucket: e.target.value as Mapping["bucket"], location_id: "" })
                          }
                        >
                          <option value="">실물 확인 후 선택</option>
                          <option value="S">정상 보관</option>
                          <option value="Q">검수·적치 대기</option>
                          <option value="B">보류</option>
                        </select>
                      </label>
                      <Select
                        label="이관 위치"
                        value={row.location_id}
                        options={options(
                          c.locations.filter(
                            (l) => l.kind === { S: "STORAGE", Q: "RECEIVING", B: "HOLD", "": "" }[row.bucket],
                          ),
                        )}
                        onChange={(location_id) => update(index, { location_id })}
                        required
                        disabled={busy}
                      />
                      <Quantity
                        value={row.quantity}
                        max={Number(original.quantity)}
                        onChange={(quantity) => update(index, { quantity })}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setRows((current) => [...current, { ...row, bucket: "", location_id: "", quantity: 1 }]);
                        setConfirmed(false);
                        setRequest(null);
                      }}
                    >
                      다른 상태·위치로 분할 배분
                    </button>
                    {rows.filter((x) => x.item_id === row.item_id && x.source_location_id === row.source_location_id)
                      .length > 1 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setRows((current) => current.filter((_, i) => i !== index));
                          setConfirmed(false);
                          setRequest(null);
                        }}
                      >
                        배분 행 제거
                      </button>
                    )}
                  </div>
                );
              })}
              {rows.length === 0 && (
                <Note>이관할 잔량이 없습니다. 기존 이력은 보존한 채 새 업무 체계로 전환합니다.</Note>
              )}
              <label className="v2-checkbox">
                <input
                  type="checkbox"
                  checked={backup}
                  onChange={(e) => setBackup(e.target.checked)}
                  required
                  disabled={busy}
                />
                전환 전 백업과 복원 절차를 확인했습니다.
              </label>
              <label className="v2-checkbox">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  required
                  disabled={busy}
                />
                실물·수량·품질·도착 위치를 확인했으며 기존 업무 쓰기를 중지하고 전환합니다.
              </label>
              <Submit
                disabled={
                  busy ||
                  c.busy ||
                  !confirmed ||
                  !backup ||
                  !preview.consistent ||
                  preview.summary.drafts > 0 ||
                  rows.some((r) => !r.bucket || !r.location_id) ||
                  preview.rows.some((r) => remaining(r) !== 0)
                }
              >
                확인한 잔량 이관·기존 업무 전환
              </Submit>
            </form>
          </>
        )}
      </section>
      <OpeningImport c={c} />
    </>
  );
}
