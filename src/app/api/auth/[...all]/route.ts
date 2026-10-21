import{trackClusterRequest}from'../../../../../deploy/cluster-request-lifecycle.mjs';
import { getAuth } from "@/server/auth/config";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return trackClusterRequest(()=>getAuth().handler(request));
}

export async function POST(request: Request) {
  return trackClusterRequest(()=>getAuth().handler(request));
}
