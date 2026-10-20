import { destinationDetail } from "@/server/delivery-destinations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return destinationDetail(request, context); }
export async function PATCH(request: Request, context: Context) { return destinationDetail(request, context); }
