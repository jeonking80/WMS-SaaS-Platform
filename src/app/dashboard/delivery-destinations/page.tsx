import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentIdentity } from "@/server/auth/access";
import Destinations from "./ui";
export default async function Page() {
 const identity = await getCurrentIdentity(new Headers(await headers()));
 if (!identity) redirect("/login");
 if (identity.role === "viewer") return <p role="alert">접근 권한이 없습니다.</p>;
 return <Destinations role={identity.role} />;
}
