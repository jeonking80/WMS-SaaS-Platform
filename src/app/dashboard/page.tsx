import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentIdentity } from "@/server/auth/access";
import LogoutButton from "./logout-button";

const roleLabels = { admin: "관리자", worker: "작업자", viewer: "조회자" } as const;

export default async function DashboardPage() {
  const identity = await getCurrentIdentity(new Headers(await headers()));
  if (!identity) redirect("/login");

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-slate-200 bg-white p-6">
        <div>
          <p className="text-sm font-semibold text-blue-800">WMS Lite</p>
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
            <div><dt className="text-sm text-slate-500">현재 회사</dt><dd data-testid="current-company" className="mt-1 font-semibold">{identity.tenant.name}</dd></div>
            <div><dt className="text-sm text-slate-500">내 역할</dt><dd data-testid="current-role" className="mt-1 font-semibold">{roleLabels[identity.role]}</dd></div>
          </dl>
        </div>
        <LogoutButton />
      </header>
      <h1 className="mt-10 text-3xl font-bold">업무 홈</h1>
      <p className="mt-4 text-slate-600">{identity.user.name}님, 환영합니다.</p>
      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="font-semibold">업무 기능 준비 중</h2>
        <p className="mt-3 leading-7 text-slate-600">회사 계정과 접근 권한을 확인했습니다. 품목·창고 및 입출고·재고 관리 기능은 순차적으로 제공할 예정입니다.</p>
      </section>
    </main>
  );
}
