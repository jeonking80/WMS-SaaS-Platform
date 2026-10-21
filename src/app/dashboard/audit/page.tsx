import {headers} from "next/headers";
import {redirect} from "next/navigation";
import {getCurrentIdentity} from "@/server/auth/access";
import Audit from "./ui";
export default async function AuditPage(){const identity=await getCurrentIdentity(new Headers(await headers()));if(!identity)redirect("/login");return identity.role==="admin"?<Audit/>:<p role="alert">접근 권한이 없습니다.</p>}
