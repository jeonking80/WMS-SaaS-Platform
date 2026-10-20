import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentIdentity } from "@/server/auth/access";
import Operations from "./ui";
import "./v2.css";
export default async function Page() {
 const identity = await getCurrentIdentity(new Headers(await headers()));
 if (!identity) redirect("/login");
 return <Operations identity={identity}/>;
}
