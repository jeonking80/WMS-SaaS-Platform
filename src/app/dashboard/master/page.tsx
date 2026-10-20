import { headers } from "next/headers";
import { getCurrentIdentity } from "@/server/auth/access";
import Master from "./ui";
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
 const identity = await getCurrentIdentity(new Headers(await headers()));
 if (!identity || identity.role === "viewer") return <p role="alert">접근 권한이 없습니다.</p>;
 const { tab } = await searchParams;
 return <Master editable={identity.role === "admin"} initialTab={tab === "warehouses" || tab === "locations" ? tab : "items"} />;
}
