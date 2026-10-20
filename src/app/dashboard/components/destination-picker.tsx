"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { control, errorText, request, RequestError } from "../api-client";
import AddressSearch, { Modal } from "./address-search";
export type DeliveryDestination = { id: string; recipient_name: string; name: string; postal_code: string; address_line1: string; address_line2: string; active: boolean; delivery_address: string };
export function DestinationEditor({ destination, onClose, onSaved }: { destination?: DeliveryDestination; onClose: () => void; onSaved: (destination: DeliveryDestination) => void }) {
 const [recipient, setRecipient] = useState(destination?.recipient_name || "");
 const [name, setName] = useState(destination?.name || "기본 배송지");
 const [address, setAddress] = useState({ postal_code: destination?.postal_code || "", address_line1: destination?.address_line1 || "" });
 const [detail, setDetail] = useState(destination?.address_line2 || "");
 const [active, setActive] = useState(destination?.active ?? true);
 const [pending, setPending] = useState(false), [error, setError] = useState("");
 const chooseAddress = useCallback((value: typeof address) => { setAddress(value); setDetail(""); }, []);
 async function save() {
  if (!address.address_line1) { setError("주소 검색으로 배송지 주소를 선택하세요."); return; }
  setPending(true); setError("");
  try { const data = await request<{ destination: DeliveryDestination }>(`/api/delivery-destinations${destination ? `/${destination.id}` : ""}`, destination ? "PATCH" : "POST", { recipient_name: recipient.trim(), name: name.trim(), ...address, address_line2: detail.trim(), ...(destination ? { active } : {}) }); onSaved(data.destination); }
  catch (e) { setError(e instanceof RequestError && ["CONFLICT", "DUPLICATE_DESTINATION"].includes(e.code) ? "같은 받는 거래처와 배송지 이름이 이미 등록되어 있습니다." : errorText(e)); }
  finally { setPending(false); }
 }
 return <Modal title={destination ? "배송지 수정" : "새 배송지 등록"} onClose={() => { if (!pending) onClose(); }}><p className="mb-4 text-sm text-slate-600">한 번 등록하면 출고 전표에서 검색하여 다시 사용할 수 있습니다.</p>{error && <p role="alert" className="mb-3 text-red-700">{error}</p>}<form onSubmit={e => { e.preventDefault(); e.stopPropagation(); void save(); }}><fieldset disabled={pending} className="grid gap-4"><label>받는 거래처<input required maxLength={128} className={`${control} block w-full`} value={recipient} onChange={e => setRecipient(e.target.value)} /></label><label>배송지 이름<input required maxLength={128} placeholder="예: 본사, 물류센터" className={`${control} block w-full`} value={name} onChange={e => setName(e.target.value)} /></label><div><AddressSearch onSelect={chooseAddress} /><p className="mt-2 text-sm text-slate-600">주소 검색으로 기본 주소를 선택하고 상세주소만 입력하세요.</p></div><label>우편번호<input readOnly className={`${control} block w-full bg-slate-50`} value={address.postal_code} /></label><label>기본 주소<input readOnly className={`${control} block w-full bg-slate-50`} value={address.address_line1} /></label><label>상세주소<input maxLength={160} className={`${control} block w-full`} value={detail} onChange={e => setDetail(e.target.value)} placeholder="동, 층, 호수 등" /></label>{destination && <label className="flex items-center gap-2"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />사용 중 (해제하면 새 출고에서 선택할 수 없습니다)</label>}<button className={`${control} bg-blue-700 text-white`}>{pending ? "저장 중…" : destination ? "배송지 수정 저장" : "배송지 등록"}</button></fieldset></form></Modal>;
}
export default function DestinationPicker({ role, value, snapshot, disabled, onChange }: { role: string; value: string; snapshot: { recipient_name: string; delivery_address: string }; disabled: boolean; onChange: (destination: DeliveryDestination) => void }) {
 const [search, setSearch] = useState(""), [rows, setRows] = useState<DeliveryDestination[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(""), [register, setRegister] = useState(false), [refresh, setRefresh] = useState(0);
 const generation = useRef(0);
 useEffect(() => {
  const current = ++generation.current;
  setLoading(true); setError(""); setRows([]);
  const timer = setTimeout(() => {
   request<{ destinations: DeliveryDestination[] }>(`/api/delivery-destinations?q=${encodeURIComponent(search)}&page=1&page_size=20`).then(data => { if (generation.current === current) { setRows(data.destinations); setLoading(false); } }).catch(e => { if (generation.current === current) { setError(errorText(e)); setLoading(false); } });
  }, 200);
  return () => { clearTimeout(timer); generation.current++; };
 }, [search, refresh]);
 return <section className="min-w-0 rounded-xl border border-blue-100 bg-blue-50/40 p-4 sm:col-span-2" aria-label="출고 배송지 선택"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h3 className="font-bold">받는 거래처 · 배송지</h3>{role === "admin" && <button type="button" className={control} disabled={disabled} onClick={() => setRegister(true)}>새 배송지 등록</button>}</div>{snapshot.recipient_name && <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3" data-testid="destination-summary"><p className="text-sm text-slate-600">{value ? "선택한 배송지" : "기존 전표의 배송정보 · 등록 배송지를 선택하여 교체할 수 있습니다"}</p><p className="font-semibold">{snapshot.recipient_name}</p><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{snapshot.delivery_address}</p></div>}<label className="block">거래처·배송지 검색<input type="search" disabled={disabled} className={`${control} mt-1 block w-full`} placeholder="거래처, 배송지 이름 또는 주소" value={search} onChange={e => setSearch(e.target.value)} /></label><p className="my-2 text-sm text-slate-600">검색 결과는 최대 20개입니다. 검색어로 배송지를 좁혀 선택하세요.</p>{loading ? <p role="status">배송지 불러오는 중…</p> : error ? <div><p role="alert" className="text-red-700">{error}</p><button type="button" className={control} disabled={disabled} onClick={() => setRefresh(v => v + 1)}>배송지 다시 불러오기</button></div> : rows.length ? <ul className="max-h-64 space-y-2 overflow-y-auto">{rows.map(row => <li key={row.id}><button type="button" aria-pressed={value === row.id} disabled={disabled} className={`w-full rounded-lg border p-3 text-left ${value === row.id ? "border-blue-600 bg-blue-100" : "border-slate-200 bg-white hover:border-blue-400"}`} onClick={() => onChange(row)}><span className="block font-semibold">{row.recipient_name} · {row.name}</span><span className="block text-sm [overflow-wrap:anywhere]">{row.postal_code && `(${row.postal_code}) `}{row.delivery_address}</span>{value === row.id && <span className="text-sm text-blue-800">선택됨</span>}</button></li>)}</ul> : <p>검색된 배송지가 없습니다.{role !== "admin" && " 관리자에게 배송지 등록을 요청하세요."}</p>}{role !== "admin" && <p className="mt-3 text-sm text-slate-600">배송지 등록·수정은 관리자에게 요청하세요.</p>}{register && <DestinationEditor onClose={() => setRegister(false)} onSaved={row => { onChange(row); setRegister(false); setRefresh(v => v + 1); }} />}</section>;
}
