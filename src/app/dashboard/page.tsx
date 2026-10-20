import { headers } from "next/headers";
import { getCurrentIdentity } from "@/server/auth/access";
import HomeMetrics from "./home-ui";
export default async function DashboardPage() {
 const identity = await getCurrentIdentity(new Headers(await headers()));
 return <section><p className="eyebrow">OPERATIONS OVERVIEW</p><h1 className="page-heading">업무 홈</h1><p className="mt-3 text-slate-600">{identity?.user.name}님, 오늘의 재고와 처리할 업무를 확인하세요.</p><HomeMetrics role={identity?.role??"viewer"}/></section>;
}
