"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { control } from "../api-client";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
 const titleId = useId();
 const dialog = useRef<HTMLDialogElement>(null);
 const close = useRef(onClose); close.current = onClose;
 useEffect(() => {
  const previous = document.activeElement as HTMLElement | null;
  const element = dialog.current!;
  element.showModal();
  return () => { element.close(); previous?.focus(); };
 }, []);
 return createPortal(<dialog ref={dialog} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); close.current(); }} className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-slate-900/50"><div className="mb-5 flex items-center justify-between gap-4"><h2 id={titleId} className="text-xl font-bold">{title}</h2><button type="button" className={control} onClick={onClose} aria-label={`${title} 닫기`}>닫기</button></div>{children}</dialog>, document.body);
}
type PostcodeData = { zonecode: string; roadAddress: string; jibunAddress: string; userSelectedType?: string };
type Postcode = new (options: { oncomplete: (data: PostcodeData) => void; width: string; height: number }) => { embed: (element: HTMLElement) => void };
declare global { interface Window { daum?: { Postcode?: Postcode } } }
let loader: Promise<void> | null = null;
function loadProvider() {
 if (window.daum?.Postcode) return Promise.resolve();
 if (loader) return loader;
 loader = new Promise<void>((resolve, reject) => {
  const script = document.createElement("script");
  script.src = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
  script.async = true;
  const finish = (failed: boolean) => { clearTimeout(timeout); script.onload = null; script.onerror = null; if (failed) { script.remove(); loader = null; reject(new Error("주소 검색 서비스를 불러오지 못했습니다.")); } else resolve(); };
  const timeout = setTimeout(() => finish(true), 15000);
  script.onload = () => finish(!window.daum?.Postcode);
  script.onerror = () => finish(true);
  document.head.appendChild(script);
 });
 return loader;
}
export default function AddressSearch({ onSelect }: { onSelect: (address: { postal_code: string; address_line1: string }) => void }) {
 const [open, setOpen] = useState(false);
 const [attempt, setAttempt] = useState(0);
 const [error, setError] = useState("");
 const [loading, setLoading] = useState(false);
 const host = useRef<HTMLDivElement>(null);
 useEffect(() => {
  if (!open) return;
  let active = true;
  setLoading(true); setError("");
  loadProvider().then(() => {
   if (!active || !host.current) return;
   host.current.replaceChildren();
   new window.daum!.Postcode!({ width: "100%", height: 440, oncomplete(data) {
    if (!active) return;
    const address = data.userSelectedType === "J" ? data.jibunAddress : data.roadAddress || data.jibunAddress;
    if (!address) { setError("선택한 주소를 확인할 수 없습니다. 다시 검색하세요."); return; }
    onSelect({ postal_code: data.zonecode, address_line1: address }); setOpen(false);
   } }).embed(host.current);
   setLoading(false);
  }).catch(() => { if (active) { setLoading(false); setError("주소 검색 서비스를 불러오지 못했습니다. 네트워크 연결을 확인하고 다시 시도하세요."); } });
  return () => { active = false; };
 }, [open, attempt, onSelect]);
 return <><button type="button" className={control} onClick={() => setOpen(true)}>주소 검색</button>{open && <Modal title="우편번호 · 주소 검색" onClose={() => setOpen(false)}><p className="mb-3 text-sm text-slate-600">도로명 또는 지번으로 검색한 뒤 주소를 선택하세요.</p>{loading && <p role="status">주소 검색 서비스 연결 중…</p>}{error && <div><p role="alert" className="text-red-700">{error}</p><button type="button" className={`${control} my-3`} onClick={() => setAttempt(value => value + 1)}>주소 검색 다시 시도</button></div>}<div ref={host} className="min-h-20 w-full" /></Modal>}</>;
}
