import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentIdentity } from "@/server/auth/access";
import LogoutButton from "./logout-button";
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
 const identity = await getCurrentIdentity(new Headers(await headers()));
 if (!identity) redirect("/login");
 const labels = { admin: "관리자", worker: "작업자", viewer: "조회자" };
 return <main className="mx-auto max-w-6xl px-6 py-10"><header className="flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-slate-200 bg-white p-6"><div><Link href="/dashboard" className="font-bold text-blue-800">WMS Lite</Link><dl className="mt-3 flex flex-wrap gap-8"><div><dt>현재 회사</dt><dd data-testid="current-company" className="font-semibold">{identity.tenant.name}</dd></div><div><dt>내 역할</dt><dd data-testid="current-role" className="font-semibold">{labels[identity.role]}</dd></div></dl></div><LogoutButton /></header><nav aria-label="업무 메뉴" className="my-6 flex gap-6"><Link href="/dashboard">업무 홈</Link>{identity.role !== "viewer" && <><Link href="/dashboard/master">기준정보 관리</Link><Link href="/dashboard/documents">입출고 전표</Link></>}</nav>{children}</main>;
}
