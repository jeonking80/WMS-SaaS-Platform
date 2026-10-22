"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
export default function Navigation({role}:{role:string}) {
 const pathname=usePathname();
 const links=[{href:"/dashboard/v2",label:"현장 운영",icon:"▣"},{href:"/dashboard",label:"업무 홈",icon:"◫"},{href:"/dashboard/stock",label:"재고 조회",icon:"▦"},{href:"/dashboard/history",label:"확정 이력",icon:"◷"},...(role!=="viewer"?[{href:"/dashboard/documents",label:"기존 전표",icon:"⇄"},{href:"/dashboard/master",label:"기준정보 관리",icon:"▤"},{href:"/dashboard/delivery-destinations",label:"배송지 관리",icon:"⌖"}]:[]),...(role==="admin"?[{href:"/dashboard/audit",label:"감사 로그",icon:"≡"}]:[])];
 return <nav aria-label="업무 메뉴" className="workspace-nav">{links.map(link=><Link prefetch={false} key={link.href} href={link.href} aria-current={pathname===link.href?"page":undefined} className="workspace-nav-link"><span aria-hidden="true">{link.icon}</span>{link.label}</Link>)}</nav>;
}
