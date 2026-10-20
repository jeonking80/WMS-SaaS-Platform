import { dashboardRequest } from "@/server/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return dashboardRequest(request); }
