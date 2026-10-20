import AcceptInvitation from "./ui";
import "../dashboard/v2/v2.css";
export default async function Page({searchParams}:{searchParams:Promise<{token?:string}>}){const {token}=await searchParams;return <AcceptInvitation token={token||''}/>;}
