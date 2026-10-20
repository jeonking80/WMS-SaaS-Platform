import { headers } from "next/headers";
import { getCurrentIdentity } from "@/server/auth/access";
import HomeMetrics from "./home-ui";
export default async function DashboardPage() {
 const identity = await getCurrentIdentity(new Headers(await headers()));
 return <section><h1 className="text-3xl font-bold">업무 홈</h1><p className="mt-4 text-slate-600">{identity?.user.name}님, 환영합니다.</p><p className="mt-4">{identity?.role === "viewer" ? "상단 재고 조회 메뉴에서 현재 재고와 재고 변동 이력을 확인하세요." : "상단 업무 메뉴에서 기준정보와 입출고 전표를 관리하세요."}</p><HomeMetrics /></section>;
}
