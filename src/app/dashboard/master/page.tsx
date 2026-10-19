import { headers } from "next/headers";
import { getCurrentIdentity } from "@/server/auth/access";
import Master from "./ui";
export default async function Page() { const identity = await getCurrentIdentity(new Headers(await headers())); if (!identity || identity.role === "viewer") return <p role="alert">접근 권한이 없습니다.</p>; return <Master editable={identity.role === "admin"} />; }
