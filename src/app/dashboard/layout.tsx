import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentIdentity } from "@/server/auth/access";
import LogoutButton from "./logout-button";
import Navigation from "./navigation";
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
 const identity = await getCurrentIdentity(new Headers(await headers()));
 if (!identity) redirect("/login");
 const labels = { admin: "관리자", worker: "작업자", supervisor: "운영 책임자", viewer: "조회자" };
 return <div className="workspace"><a className="skip-link" href="#workspace-content">본문으로 이동</a><aside className="workspace-sidebar"><Link href="/dashboard" className="workspace-brand"><span className="brand-mark" aria-hidden="true">W</span><span>WMS Lite<small>WAREHOUSE OPERATIONS</small></span></Link><p className="nav-caption">워크스페이스</p><Navigation role={identity.role}/><div className="sidebar-note">재고의 흐름을 한곳에서<br/><span>입고 · 출고 · 이동 · 이력</span></div></aside><div className="workspace-body"><header className="workspace-topbar"><dl className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 text-sm"><div><dt className="text-xs text-slate-500">현재 회사</dt><dd data-testid="current-company" className="mt-1 font-bold text-slate-900">{identity.tenant.name}</dd></div><div><dt className="text-xs text-slate-500">내 역할</dt><dd data-testid="current-role" className="mt-1 font-semibold text-blue-700">{labels[identity.role]}</dd></div></dl><LogoutButton/></header><main id="workspace-content" className="workspace-content">{children}</main></div></div>;
}
